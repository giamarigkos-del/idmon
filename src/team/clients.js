// src\team\clients.js
// Section W (2 Οκτ 2026): ΠΡΟΦΙΛ ΧΩΡΟΥ και ΠΕΛΑΤΕΣ (τοίχοι).
//
// Δύο προφίλ, ένας κώδικας:
//   "company":      μία εταιρεία (Apple, eFood). Χωρίς τοίχους. Τα τμήματα διαμοιράζουν ελεύθερα έγγραφα. Δουλεύει ακριβώς όπως πριν.
//   "multi_client": call center με πολλούς πελάτες. Κάθε πελάτης είναι ΤΟΙΧΟΣ: τίποτα δεν περνά από τον έναν στον άλλον (ακροατήριο,
//                   αντιφάσεις, ανάγνωση). Τα τμήματα του πελάτη ζουν μέσα του και διαμοιράζονται ελεύθερα μόνο μεταξύ τους.
// Projects χωρίς πελάτη στο "multi_client" είναι τα ΕΣΩΤΕΡΙΚΑ του call center (δικός τους τοίχος, "internal").
//
// Το όνομα (departments.name) ενός project πελάτη είναι "<πελάτης> · <τμήμα>": μοναδικό ανά workspace (ο περιορισμός UNIQUE της βάσης
// δεν αλλάζει), και δείχνει παντού σε ποιον πελάτη ανήκει. Το σκέτο όνομα τμήματος μένει στο team_project_clients.short_name.
//
// ΠΑΛΙ ΑΠΟΛΥΤΩΣ ΠΡΟΣΘΕΤΙΚΟ (migration 0016): χωρίς τους πίνακες ο κώδικας δουλεύει ως "company" και μόνο οι ενέργειες πελατών δίνουν
// 503 clients_unavailable.

import { json, loadWorkspaceDepartments, loadWorkspaceProfile } from "./auth.js";
import { recordAudit } from "./audit.js";
import { INTERNAL_WALL, wallOf } from "./access.js";
import { listDocIndex } from "./store.js";

const MAX_NAME_CHARS = 60;
export const NAME_SEPARATOR = " · ";

export const cleanName = (raw) => (typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "");
// Το "·" είναι ο διαχωριστής του ονόματος project πελάτη: δεν επιτρέπεται μέσα σε όνομα πελάτη ή τμήματος.
export const validName = (name) => !!name && name.length <= MAX_NAME_CHARS && !name.includes("·");
export const composeProjectName = (clientName, shortName) => `${clientName}${NAME_SEPARATOR}${shortName}`;

const isNoTable = (err) => /no such table/i.test(String((err && err.message) || err));

async function runStatements(env, statements) {
  if (!statements.length) return;
  if (typeof env.DB.batch === "function") await env.DB.batch(statements);
  else for (const s of statements) await s.run();
}

// Υπάρχουν οι πίνακες του migration 0016; Άλλο σφάλμα βάσης ξαναπετιέται (fail closed).
export async function clientsAvailable(env) {
  try {
    await env.DB.prepare("SELECT 1 AS x FROM team_clients LIMIT 1").first();
    return true;
  } catch (err) {
    if (isNoTable(err)) return false;
    throw err;
  }
}

export async function loadClients(env, workspaceId) {
  try {
    const res = await env.DB.prepare(
      `SELECT c.id, c.name, (SELECT count(*) FROM team_project_clients pc WHERE pc.client_id = c.id) AS projectCount
         FROM team_clients c WHERE c.workspace_id = ? ORDER BY c.name`
    ).bind(workspaceId).all();
    return ((res && res.results) || []).map((c) => ({ id: c.id, name: c.name, projectCount: Number(c.projectCount) || 0 }));
  } catch (err) {
    if (isNoTable(err)) return [];
    throw err;
  }
}

async function loadClient(env, workspaceId, id) {
  if (typeof id !== "string" || !id) return null;
  return env.DB.prepare("SELECT id, name FROM team_clients WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first();
}

// Η γραμμή πελάτη ενός project (ή null).
export async function projectClientRow(env, projectId) {
  try {
    return await env.DB.prepare(
      `SELECT pc.client_id AS clientId, pc.short_name AS shortName, c.name AS clientName
         FROM team_project_clients pc JOIN team_clients c ON c.id = pc.client_id WHERE pc.project_id = ?`
    ).bind(projectId).first();
  } catch (err) {
    if (isNoTable(err)) return null;
    throw err;
  }
}

const nameTaken = (departments, name, exceptId) =>
  departments.some((d) => d.id !== exceptId && String(d.name).toLowerCase() === String(name).toLowerCase());

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ PATCH /team/admin/workspace  { profile }
export async function handleSetProfile(request, rc) {
  const { env, member } = rc;
  const body = await readBody(request);
  if (!body) return json(400, { error: "invalid_json" });
  if (body.profile !== "company" && body.profile !== "multi_client") return json(400, { error: "invalid_profile" });
  if (!(await clientsAvailable(env))) return json(503, { error: "clients_unavailable" });
  const current = await loadWorkspaceProfile(env, member.workspaceId);
  if (current === body.profile) return json(200, { ok: true, profile: current });
  // Πίσω σε "company" μόνο όταν δεν έχει μείνει κανένας πελάτης (αλλιώς θα χάνονταν οι τοίχοι σιωπηλά).
  if (body.profile === "company" && (await loadClients(env, member.workspaceId)).length) return json(409, { error: "has_clients" });
  await env.DB.prepare(
    `INSERT INTO team_workspace_settings (workspace_id, profile, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(workspace_id) DO UPDATE SET profile = excluded.profile, updated_at = excluded.updated_at`
  ).bind(member.workspaceId, body.profile, new Date().toISOString()).run();
  await recordAudit(env, member, "workspace_profile_changed", null, { from: current, to: body.profile });
  return json(200, { ok: true, profile: body.profile });
}

// ------------------------------------------------------------------ POST /team/admin/clients  { name }
export async function handleCreateClient(request, rc) {
  const { env, deps, member } = rc;
  const body = await readBody(request);
  if (!body) return json(400, { error: "invalid_json" });
  const name = cleanName(body.name);
  if (!validName(name)) return json(400, { error: "invalid_name" });
  if (!(await clientsAvailable(env))) return json(503, { error: "clients_unavailable" });
  if ((await loadWorkspaceProfile(env, member.workspaceId)) !== "multi_client") return json(409, { error: "profile_company" });
  const existing = await loadClients(env, member.workspaceId);
  if (existing.some((c) => c.name.toLowerCase() === name.toLowerCase())) return json(409, { error: "name_taken" });
  const id = `c-${deps.randomHex(4)}`;
  await env.DB.prepare("INSERT INTO team_clients (id, workspace_id, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, member.workspaceId, name, new Date().toISOString()).run();
  await recordAudit(env, member, "client_created", id, { name });
  return json(201, { id, name, projectCount: 0 });
}

// ------------------------------------------------------------------ PATCH /team/admin/clients/{id}  { name }
// Μετονομασία πελάτη: αλλάζουν και τα ονόματα των projects του ("<πελάτης> · <τμήμα>"). Όλα ή τίποτα.
export async function handleRenameClient(request, rc, id) {
  const { env, member } = rc;
  const body = await readBody(request);
  if (!body) return json(400, { error: "invalid_json" });
  const name = cleanName(body.name);
  if (!validName(name)) return json(400, { error: "invalid_name" });
  const client = await loadClient(env, member.workspaceId, id);
  if (!client) return json(404, { error: "not_found" });
  const clients = await loadClients(env, member.workspaceId);
  if (clients.some((c) => c.id !== id && c.name.toLowerCase() === name.toLowerCase())) return json(409, { error: "name_taken" });

  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const mine = departments.filter((d) => d.clientId === id);
  const renamed = mine.map((d) => ({ id: d.id, name: composeProjectName(name, d.shortName) }));
  const others = departments.filter((d) => d.clientId !== id);
  if (renamed.some((r) => nameTaken(others, r.name, r.id))) return json(409, { error: "name_taken" });

  const statements = [env.DB.prepare("UPDATE team_clients SET name = ? WHERE id = ?").bind(name, id)];
  for (const r of renamed) statements.push(env.DB.prepare("UPDATE departments SET name = ? WHERE id = ?").bind(r.name, r.id));
  await runStatements(env, statements);
  await recordAudit(env, member, "client_renamed", id, { from: client.name, to: name });
  return json(200, { ok: true });
}

// ------------------------------------------------------------------ DELETE /team/admin/clients/{id}
// Μόνο άδειος πελάτης (χωρίς projects). Η διαγραφή πελάτη με δεδομένα (λήξη σύμβασης) έρχεται σε επόμενο βήμα, με πλήρη καθαρισμό.
export async function handleDeleteClient(rc, id) {
  const { env, member } = rc;
  const client = await loadClient(env, member.workspaceId, id);
  if (!client) return json(404, { error: "not_found" });
  const mine = (await loadClients(env, member.workspaceId)).find((c) => c.id === id);
  if (mine && mine.projectCount > 0) return json(409, { error: "client_has_projects" });
  await env.DB.prepare("DELETE FROM team_clients WHERE id = ?").bind(id).run();
  await recordAudit(env, member, "client_deleted", id, { name: client.name });
  return json(200, { ok: true });
}

// Πόσα έγγραφα θα έμεναν να μοιράζονται ΠΑΝΩ από τον τοίχο αν το project πήγαινε στον νέο τοίχο:
//   owned:    έγγραφα του project με ακροατήριο σε project άλλου τοίχου
//   incoming: έγγραφα άλλων projects (σε άλλον τοίχο από τον νέο) που μοιράζονται προς αυτό το project
async function crossWallShares(env, workspaceId, projectId, newWall, departments) {
  const index = await listDocIndex(env, workspaceId);
  const wallAfter = (pid) => (pid === projectId ? newWall : wallOf(departments, pid));
  let owned = 0;
  let incoming = 0;
  for (const d of index) {
    if (!d.audienceProjectIds || !d.audienceProjectIds.length || d.departmentId === "_all") continue;
    if (d.departmentId === projectId) {
      if (d.audienceProjectIds.some((p) => wallAfter(p) !== newWall)) owned++;
    } else if (d.audienceProjectIds.includes(projectId) && wallAfter(d.departmentId) !== newWall) {
      incoming++;
    }
  }
  return { owned, incoming };
}

// ------------------------------------------------------------------ PUT /team/admin/departments/{id}/client  { clientId: string|null, shortName? }
// Μεταφορά project σε πελάτη (ή σε "εσωτερικά" με clientId null). Μετακίνηση ανάμεσα σε τοίχους είναι σοβαρή ενέργεια: επιτρέπεται ΜΟΝΟ
// αν δεν θα έμενε κανένα έγγραφο κοινό ανάμεσα σε δύο τοίχους (αλλιώς 409 με πλήθη και πρώτα αφαιρείται ο διαμοιρασμός).
export async function handleAssignProjectClient(request, rc, projectId) {
  const { env, member } = rc;
  const body = await readBody(request);
  if (!body || (body.clientId !== null && typeof body.clientId !== "string")) return json(400, { error: "invalid_client" });
  if (!(await clientsAvailable(env))) return json(503, { error: "clients_unavailable" });
  const departments = await loadWorkspaceDepartments(env, member.workspaceId);
  const dept = departments.find((d) => d.id === projectId);
  if (!dept) return json(404, { error: "not_found" });
  if ((await loadWorkspaceProfile(env, member.workspaceId)) !== "multi_client") return json(409, { error: "profile_company" });

  let client = null;
  if (body.clientId !== null) {
    client = await loadClient(env, member.workspaceId, body.clientId);
    if (!client) return json(404, { error: "client_not_found" });
  }
  // Το σκέτο όνομα του τμήματος: ό,τι ζητήθηκε, αλλιώς το τρέχον σκέτο όνομα, αλλιώς το τρέχον όνομα.
  const requested = body.shortName === undefined ? null : cleanName(body.shortName);
  if (requested !== null && !validName(requested)) return json(400, { error: "invalid_name" });
  const short = requested || dept.shortName || dept.name;
  if (!validName(short)) return json(400, { error: "invalid_name" });
  const newName = client ? composeProjectName(client.name, short) : short;
  if (nameTaken(departments, newName, projectId)) return json(409, { error: "name_taken" });

  const oldWall = dept.clientId || INTERNAL_WALL;
  const newWall = client ? client.id : INTERNAL_WALL;
  if (oldWall !== newWall) {
    const shares = await crossWallShares(env, member.workspaceId, projectId, newWall, departments);
    if (shares.owned || shares.incoming) return json(409, { error: "cross_client_shares", owned: shares.owned, incoming: shares.incoming });
  }

  const statements = [env.DB.prepare("UPDATE departments SET name = ? WHERE id = ?").bind(newName, projectId)];
  if (client) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO team_project_clients (project_id, client_id, short_name) VALUES (?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET client_id = excluded.client_id, short_name = excluded.short_name`
      ).bind(projectId, client.id, short)
    );
  } else {
    statements.push(env.DB.prepare("DELETE FROM team_project_clients WHERE project_id = ?").bind(projectId));
  }
  await runStatements(env, statements);
  if (oldWall !== newWall || newName !== dept.name) {
    await recordAudit(env, member, "project_client_changed", projectId, {
      from: dept.clientName || "εσωτερικά", to: client ? client.name : "εσωτερικά", name: short,
    });
  }
  return json(200, { ok: true, name: newName });
}