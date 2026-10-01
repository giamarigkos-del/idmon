// src\team\maintenance.js
// Section W: περιοδική συντήρηση (cron κάθε 5 λεπτά στο lab). Τώρα: επανέλεγχος αντιφάσεων που εκκρεμεί και καθαρισμός
// παλιών μετρητών. Δεν πετάει ποτέ σφάλμα προς τα έξω.

import { runDueRechecks } from "./contradictions.js";
import { purgeOldUsage } from "./quota.js";

export async function runTeamMaintenance(env, deps) {
  const rechecks = await runDueRechecks(env, deps, {});
  await purgeOldUsage(env);
  return { rechecks };
}