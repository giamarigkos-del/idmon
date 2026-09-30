# Idmon για ομάδες: τι έχει χτιστεί (Φέτες 1-4)

Πειραματικός κλάδος `team-experiment`. Ο κώδικας ζει στο `src/team/`, στις σελίδες `portal.html`, `team-editor.html`, `team-admin.html` και στα migrations 0010 και 0011. Το SMB προϊόν δεν αλλάζει (μόνο πρόσθετες αλλαγές στο `src/index.js`).

## Ρόλοι
| Ρόλος | Διαβάζει | Γράφει | Βλέπει |
|---|---|---|---|
| Υπάλληλος | δικά του τμήματα + εταιρικά | τίποτα | portal, updates |
| Editor | ίδια + άλλα ΜΗ κρυφά (ανάγνωση) | μόνο δικά του τμήματα | + εισερχόμενα (αντιφάσεις, updates, αναπάντητες) |
| Admin | όλα | όλα, και εταιρικά | + διαχείριση, ιστορικό ενεργειών |

Ο βοηθός αναζητά μόνο στα δικά σου τμήματα και τα εταιρικά (ο admin χωρίς περιορισμό).

## Αντιφάσεις
Μετά από κάθε αποθήκευση (στο παρασκήνιο): vectors → υποψήφια έγγραφα → LLM κριτής → ο κώδικας επαληθεύει ότι οι παραθέσεις υπάρχουν αυτούσιες. Μηδενικές ψευδείς "επινοήσεις". Ρύθμιση ευαισθησίας: μεταβλητή `TEAM_CONTRADICTION_MIN_SCORE` (προεπιλογή 0.70). Αν χάνει αντιφάσεις κατέβασέ την (0.60), αν βρίσκει πολλά άσχετα ανέβασέ την.
Κρυφό τμήμα: ο editor βλέπει μόνο "υπάρχει αντίφαση, ειδοποιήθηκε ο admin".

## Updates
Δένονται σε βασικό έγγραφο και είναι ΑΜΕΣΩΣ αναζητήσιμα (με σήμανση "πρόσφατη ενημέρωση"). Η ενσωμάτωση γίνεται ΠΑΝΤΑ με έγκριση editor: το σύστημα προτείνει, ο editor βλέπει diff, διορθώνει και εγκρίνει.

## Endpoints (όλα κάτω από /team)
- Χωρίς session: `POST /login/start`, `/login/verify`, `/logout`
- Όλοι: `GET /me`, `/departments`, `/documents`, `/documents/{id}`, `POST /query/stream`
- Έγγραφα (editor/admin): `POST /documents`, `PUT|DELETE /documents/{id}`, `POST /documents/{id}/check`
- Εισερχόμενα (editor/admin): `GET /inbox`, `POST /inbox/questions/dismiss`, `GET /contradictions`, `POST /contradictions/{id}/dismiss|remind`, `POST /updates`, `POST /updates/{id}/propose|apply|reject`
- Admin: `GET /admin/overview|audit`, `POST /admin/departments|members`, `PATCH /admin/departments/{id}|members/{id}`

## Γνωστά κενά
- Ο έλεγχος αντιφάσεων τρέχει στο publish και στο apply, ΟΧΙ πάνω σε εκκρεμή updates.
- Χωρίς Turnstile στο login (μόνο rate limit). Χωρίς όριο ερωτήσεων ανά χρήστη.
- Δεν υπάρχει σήμανση "εμπιστευτικό έγγραφο" (μόνο κρυφό τμήμα). Ένα τμήμα ανά έγγραφο.
- Σε τμήμα με έναν υπάλληλο, μια αναπάντητη ερώτηση προδίδει ποιος την έκανε.
