<!-- lab\RUNBOOK-new-client.md -->
# Onboarding νέου πελάτη στο lab (Idmon για ομάδες)

Σήμερα δεν υπάρχει σελίδα εγγραφής. Τον πρώτο χώρο και τον πρώτο admin τους φτιάχνουμε ΕΜΕΙΣ, με ένα script. Μετά αποσυρόμαστε: ο admin του πελάτη φτιάχνει τμήματα, προσθέτει ανθρώπους και ορίζει editors.

Αναλογία: ο χώρος είναι ένα διαμέρισμα στην πολυκατοικία Idmon και ο πρώτος admin είναι ο ένοικος με το κλειδί. Το script βάζει το όνομα στο κουδούνι (το id πρέπει να ξεκινά από `team-`) και δίνει το κλειδί.

Ισχύει ΜΟΝΟ για το lab (`idmon-lab-accounts`). Το script δεν αγγίζει ποτέ το production.

## 1. Πριν τρέξεις το script: τι ρωτάς τον πελάτη

1. **Όνομα οργανισμού** (π.χ. `Acme`).
2. **ΔΥΟ emails admin** (επαγγελματικά). Ένας admin είναι σημείο αποτυχίας: αν φύγει ή χάσει το email, ο πελάτης δεν διαχειρίζεται τίποτα. Δύο έως τρεις, όχι πολλοί, γιατί ο admin διαβάζει τα πάντα. Στο call center μόνο ops/IT, γιατί ο admin περνά και τους τοίχους των πελατών.
3. **Τύπος χώρου**: `company` (μία εταιρεία, π.χ. Apple, eFood) ή `multi_client` (call center με πολλούς πελάτες, π.χ. Teleperformance). Ο τύπος ορίζεται ΠΡΙΝ μπουν δεδομένα.
4. Ένα email ανήκει σε ΕΝΑΝ οργανισμό σε όλο το σύστημα. Το script το ελέγχει.

Πριν από πραγματικό πελάτη πρέπει να έχει γραφτεί η συμφωνία (DPA). Ως πάροχος μπορούμε τεχνικά να δούμε τη βάση. Τα κείμενα επεξεργάζονται από Google (Gemini) και φιλοξενούνται στο Cloudflare: δηλώνονται ως υπεργολάβοι.

## 2. Δοκιμή (δεν αλλάζει τίποτα)

Από τον φάκελο του repo, στο PowerShell:

```powershell
node lab\new-client.mjs --id team-acme --name "Acme" --admin ceo@acme.example --admin it@acme.example
```

Τυπώνει τι θα γραφόταν. Αν κάτι δεν πάει καλά (id χωρίς `team-`, email λάθος, δύο ίδια emails), σταματά με σαφές μήνυμα και δεν γράφει τίποτα. Για call center πρόσθεσε `--profile multi_client`. Κατάσταση: `--status pilot|active|paused` (προεπιλογή `pilot`, το `paused` κλείνει το login).

## 3. Εκτέλεση

Ίδια εντολή, με `--run` στο τέλος:

```powershell
node lab\new-client.mjs --id team-acme --name "Acme" --admin ceo@acme.example --admin it@acme.example --run
```

Κάνει τρία βήματα και τα τυπώνει: (1) ελέγχει ότι ο χώρος και τα emails δεν υπάρχουν ήδη (αλλιώς δεν γράφει ΤΙΠΟΤΑ), (2) δημιουργεί τον χώρο και τους admins, (3) επαληθεύει διαβάζοντας τα ξανά από τη βάση. Στο τέλος γράφει ΕΤΟΙΜΟ.

Αν δεις `Authentication error [code: 10000]`, είναι διαλείπον του Cloudflare: το script ξαναδοκιμάζει μόνο του.

## 4. Τι λες στον πελάτη

1. Άνοιξε https://idmon-lab.giamarigkos.workers.dev/portal
2. Γράψε το επαγγελματικό email σου και ζήτα σύνδεσμο.
3. Πάτα τον σύνδεσμο που θα έρθει (ισχύει 15 λεπτά, χρησιμοποιείται μία φορά, δεν υπάρχουν κωδικοί).
4. Πρώτη μέρα: από τη Διαχείριση, καρτέλα Άνθρωποι, πρόσθεσε τον δεύτερο admin.

## 5. Μόνο call center

Αν δεν χρησιμοποίησες `--profile multi_client`, άλλαξε τον «Τύπο χώρου» σε Call center από τη Διαχείριση (καρτέλα Projects, κάρτα «Τύπος χώρου») ΠΡΙΝ μπουν δεδομένα. Μετά ο admin φτιάχνει πελάτες (τοίχοι), και μέσα σε κάθε πελάτη τμήματα.

## 6. Αν κάτι πάει στραβά

- **Το script σταμάτησε με «Υπάρχουν ήδη»**: ο χώρος ή κάποιο email υπάρχει. Δεν γράφτηκε τίποτα. Διάλεξε άλλο id ή άλλο email.
- **Το script έδωσε ΣΦΑΛΜΑ στη δημιουργία (βήμα 2)**: ξανάτρεξε την ΙΔΙΑ εντολή. Ο έλεγχος του βήματος 1 θα δείξει τι πρόλαβε να γραφτεί.
- **Επαλήθευση (μόνο ανάγνωση)**, για να δεις τον χώρο:

```powershell
npx wrangler d1 execute idmon-lab-accounts --remote -c wrangler.lab.toml --command "SELECT w.id, w.name, w.status, m.email, m.role, m.status AS member_status FROM team_workspaces w LEFT JOIN team_members m ON m.workspace_id = w.id WHERE w.id = 'team-acme' ORDER BY m.email;"
```

- **Ο χώρος φτιάχτηκε μισός και είναι ΚΑΙΝΟΥΡΓΙΟΣ και ΑΔΕΙΟΣ** (δεν έχει μπει ούτε ένα δεδομένο): μπορείς να τον σβήσεις με μία εντολή. Τα μέλη και οι ρυθμίσεις του φεύγουν μαζί του (ON DELETE CASCADE). ΜΗΝ το κάνεις ποτέ σε χώρο που έχει έγγραφα ή τμήματα.

```powershell
npx wrangler d1 execute idmon-lab-accounts --remote -c wrangler.lab.toml --command "DELETE FROM team_workspaces WHERE id = 'team-acme';"
```

## 7. Χειροκίνητη εναλλακτική (αν δεν δουλεύει το script)

Δύο εντολές, μία τη φορά. Το id ΠΡΕΠΕΙ να ξεκινά από `team-`. Προσοχή: ένα email που υπάρχει ήδη αλλού δεν θα μπει και το `OR IGNORE` δεν θα σε προειδοποιήσει, γι' αυτό τρέξε μετά την επαλήθευση της ενότητας 6.

```powershell
npx wrangler d1 execute idmon-lab-accounts --remote -c wrangler.lab.toml --command "INSERT OR IGNORE INTO team_workspaces (id, name, status, created_at) VALUES ('team-acme', 'Acme', 'pilot', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));"
```

```powershell
npx wrangler d1 execute idmon-lab-accounts --remote -c wrangler.lab.toml --command "INSERT OR IGNORE INTO team_members (workspace_id, email, role, status, created_at) VALUES ('team-acme', 'ceo@acme.example', 'admin', 'active', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));"
```

Η δεύτερη εντολή ξανά για κάθε επιπλέον admin.

## 8. Τι ΔΕΝ υπάρχει ακόμα

Εγγραφή από τον ίδιο τον πελάτη, SSO, δικό τους domain ή λογότυπο, αρχειοθέτηση ή διαγραφή τμήματος, διαγραφή μέλους (μόνο απενεργοποίηση). Δες το idmon-team-backlog.txt.
