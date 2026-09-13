// Κάθε επισκέπτης διαλέγει ρητά, στη landing page, "Developer" (με κωδικό,
// πάει στο πραγματικό demo workspace) ή "Επισκέπτης/Guest" (παίρνει ένα
// τυχαίο, δικό του, απομονωμένο workspace). Η επιλογή αποθηκεύεται εδώ
// (localStorage) ώστε να μη ρωτάει ξανά στο ίδιο browser. Αν δεν έχει γίνει
// ακόμα καμία επιλογή, στέλνουμε στη landing page πριν φορτώσει οτιδήποτε
// άλλο -- δεν έχει νόημα να καλέσουμε το backend χωρίς workspace.
//
// ΣΗΜΑΝΤΙΚΟ: η landing.html φορτώνει ΚΙ ΑΥΤΗ το shared.js (για τις i18n
// συναρτήσεις), οπότε ΔΕΝ πρέπει ποτέ να ανακατευθύνει τον εαυτό της σε
// τον εαυτό της. Παλιότερα αυτό ελεγχόταν συγκρίνοντας το URL
// (window.location.pathname.endsWith(...)), αλλά αυτό αποδείχτηκε εύθραυστο
// -- π.χ. ένα trailing slash στο URL (/landing.html/) το έσπαγε και
// δημιουργούσε άπειρο βρόχο ανανέωσης. Αντ' αυτού, η landing.html δηλώνει
// ρητά μια global σημαία (window.__IS_LANDING_PAGE__ = true) ΠΡΙΝ φορτώσει
// το shared.js -- καμία εξάρτηση από το πώς μοιάζει το URL.
//
// Επιπλέον, ασφάλεια δεύτερου επιπέδου: αν παρ' όλα αυτά κάτι προσπαθήσει να
// ανακατευθύνει ξανά μέσα στο ίδιο tab χωρίς ποτέ να αποκτήσει workspaceId,
// σταματάμε μετά την πρώτη προσπάθεια αντί να μπούμε σε άπειρο βρόχο.
function resolveWorkspaceId() {
  const stored = localStorage.getItem("workspaceId");
  if (stored) return stored;

  if (window.__IS_LANDING_PAGE__) return null;

  const alreadyRedirected = sessionStorage.getItem("landingRedirectAttempted");
  if (alreadyRedirected) return null;

  sessionStorage.setItem("landingRedirectAttempted", "1");
  window.location.href = "/landing.html";
  return null;
}

const WORKSPACE_ID = resolveWorkspaceId();
const SESSION_TOKEN = localStorage.getItem("sessionToken");
const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "X-Workspace-Id": WORKSPACE_ID,
  // Section H: αν υπάρχει session (login μέσω account, όχι Developer/Guest),
  // το backend το προτιμάει ΠΑΝΤΑ έναντι του X-Workspace-Id -- το τελευταίο
  // μένει μόνο για συμβατότητα με το Developer/Guest flow.
  ...(SESSION_TOKEN ? { "X-Session-Token": SESSION_TOKEN } : {}),
};

// Section H: κοινό logout -- ακυρώνει το session στο backend (best-effort,
// δεν μπλοκάρει ποτέ την πλοήγηση αν αποτύχει το request), καθαρίζει το
// localStorage, και γυρνάει στη landing page. Χρησιμοποιείται από το
// "switch mode" link σε index.html/editor.html -- μία υλοποίηση, όχι δύο
// αντίγραφα.
// Section L: streaming. Διαβάζει ένα SSE response (Response.body είναι
// ReadableStream) και καλεί onEvent(parsedJson) για κάθε "data: {...}"
// γραμμή. Το ΙΔΙΟ πρωτόκολλο ορίζεται και στο backend (buildStreamingQueryResponse
// στο index.js) και ξανα-υλοποιείται (σκόπιμα, αντιγραμμένο) μέσα στο
// widget.js, που πρέπει να μείνει αυτόνομο αρχείο χωρίς εξάρτηση σε αυτό.
async function streamSSE(response, onEvent) {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = rawEvent.trim();
      if (!line.startsWith("data:")) continue;
      const jsonStr = line.slice(5).trim();
      if (!jsonStr) continue;
      try {
        onEvent(JSON.parse(jsonStr));
      } catch (err) {
        // αγνόησε γραμμές που δεν είναι έγκυρο JSON
      }
    }
  }
}

async function logoutAndSwitchMode() {
  if (SESSION_TOKEN) {
    try {
      await fetch("/account/logout", {
        method: "POST",
        headers: { "X-Session-Token": SESSION_TOKEN },
      });
    } catch (err) {
      // best-effort -- ακόμα κι αν αποτύχει το logout call, συνεχίζουμε να
      // καθαρίσουμε το τοπικό state και να φύγουμε από τη σελίδα.
    }
  }
  localStorage.removeItem("workspaceId");
  localStorage.removeItem("sessionToken");
  window.location.href = "/landing.html";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Μετατρέπει **bold** και newlines σε πραγματικό HTML -- χρησιμοποιείται
// τόσο στο chat widget όσο και στο δοκιμαστικό ερώτημα του editor, ώστε
// και τα δύο να δείχνουν καθαρή, μορφοποιημένη απάντηση, ποτέ raw κείμενο.
function formatAnswer(text) {
  let safe = escapeHtml(text);
  safe = safe.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\n/g, "<br>");
  return safe;
}

// Πλήρης μετατροπή markdown -> HTML για το κείμενο ενός εγγράφου. Χρησιμοποιεί
// το marked.js (πλήρες markdown: επικεφαλίδες, links, πίνακες, code, quotes,
// λίστες, **bold**, *πλάγια* κ.λπ.) και το DOMPurify για καθαρισμό του HTML
// πριν μπει στη σελίδα -- το marked ΔΕΝ καθαρίζει μόνο του το output του.
// Ίδια συνάρτηση χρησιμοποιείται στο live preview του editor, στο read-only
// preview, και στη δημόσια σελίδα άρθρου -- μία πηγή αλήθειας για το πώς
// φαίνεται το κείμενο.
function renderMarkdown(text) {
  if (!text) return "";
  const html = marked.parse(text);
  return typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(html) : html;
}

// Παράγει τεχνικό documentId από τον τίτλο -- ο editor δεν χρειάζεται ποτέ
// να σκεφτεί ή να πληκτρολογήσει ID χειροκίνητα. Μετατρέπει Ελληνικά σε
// Λατινικά (ίδιο στυλ με τα ήδη υπάρχοντα slugs: shop-journey,
// verification-process), αφαιρεί τόνους/κενά, κρατάει μόνο πεζά+παύλες.
const GREEK_TO_LATIN = {
  "α":"a","ά":"a","β":"v","γ":"g","δ":"d","ε":"e","έ":"e","ζ":"z","η":"i","ή":"i",
  "θ":"th","ι":"i","ί":"i","ϊ":"i","ΐ":"i","κ":"k","λ":"l","μ":"m","ν":"n","ξ":"x",
  "ο":"o","ό":"o","π":"p","ρ":"r","σ":"s","ς":"s","τ":"t","υ":"y","ύ":"y","ϋ":"y","ΰ":"y",
  "φ":"f","χ":"ch","ψ":"ps","ω":"o","ώ":"o",
};

function slugify(title) {
  const lower = String(title).trim().toLowerCase();
  let out = "";
  for (const ch of lower) {
    out += GREEK_TO_LATIN[ch] !== undefined ? GREEK_TO_LATIN[ch] : ch;
  }
  out = out
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out || "";
}

// ============================================================================
// i18n (EN/GR δίγλωσσο UI). ΜΟΝΟ το UI (κουμπιά, labels, μηνύματα) -- τα ίδια
// τα έγγραφα (SOPs κ.λπ.) ΔΕΝ μεταφράζονται, μένουν στη γλώσσα που γράφτηκαν.
// Η γλώσσα αποθηκεύεται στο localStorage ("uiLang"), προεπιλογή "en" αν δεν
// έχει επιλεγεί ποτέ. Το toggle κουμπί (βλ. initLangToggle) απλά αλλάζει το
// localStorage και ξαναφορτώνει τη σελίδα -- πιο απλό και ασφαλές από το να
// ξαναφτιάχνουμε "ζωντανά" όλο το δυναμικό περιεχόμενο (λίστες, chat κ.λπ.)
// χωρίς reload.
// ============================================================================
const TRANSLATIONS = {
  en: {
    // κοινά
    loading: "Loading…",
    cancel: "Cancel",
    switchMode: "Switch mode",
    manageContent: "Manage content",
    updatedPrefix: "Updated",
    loadErrorPrefix: "Loading error: ",
    genericErrorPrefix: "Error: ",
    noResults: "No results.",
    draftBadge: "Draft",
    edit: "Edit",
    publish: "Publish",
    delete: "Delete",
    restore: "Restore",
    noDocsYet: "No documents yet.",
    expiresToday: "Expires today",
    expiresInDay: "Expires in {days} day",
    expiresInDays: "Expires in {days} days",

    // landing.html
    landingDocTitle: "Operations Portal — Welcome",
    landingIntro: "Before you continue, choose how you'll enter.",
    devTitle: "Developer",
    devDesc: "Access to the real content workspace (requires a password).",
    guestTitle: "Guest",
    guestDesc: "Freely try the tool in your own separate space. Nobody else sees what you upload, and it's automatically deleted after 7 days.",
    accountTitle: "Account",
    accountDesc: "Sign up or log in to your own permanent workspace, from any device.",
    signupTab: "Sign up",
    loginTab: "Log in",
    emailLabel: "Email",
    passwordLabel: "Password",
    signupBtn: "Sign up",
    devPasswordLabel: "Developer password",
    login: "Log in",
    checking: "Checking…",
    wrongPassword: "Wrong password.",
    connectionErrorPrefix: "Connection error: ",

    // index.html
    indexDocTitle: "Operations Portal — Assistant",
    recentDocs: "Recent documents",
    hostIntro: "Company procedures and policies. Click a document to read it, or ask the assistant bottom-right.",
    noDocsInWorkspace: "There are no documents yet in this workspace.",
    docsLoadError: "Error loading documents.",
    assistantTitle: "Assistant",
    conversation: "Conversation",
    askPlaceholder: "Ask something…",
    send: "Send",
    answerFrom: "This answer comes from: ",
    viewArticle: "View article →",

    // article.html
    articleDocTitle: "Article — Documentation Assistant",
    noDocIdFound: "No document identifier found.",
    docNotFound: "Document not found.",
    docNotPublished: "This document hasn't been published yet.",
    updatedColon: "Updated:",

    // editor.html
    editorDocTitle: "Content Management — Operations Portal",
    editorHeading: "Content Management",
    newDoc: "+ New document",
    filterByTitle: "Filter by title…",
    documentsLabel: "Documents",
    allDocs: "All documents",
    backToAllDocs: "← All documents",
    searchByDescription: "Find by description",
    searchExamplePlaceholder: "e.g. Billing's working hours…",
    testQuestion: "Test question",
    testQuestionPlaceholder: "e.g. What's the approval limit?",
    unansweredQuestions: "Unanswered questions",
    refresh: "↻ Refresh",
    deletedToggleShow: "Show deleted ({count})",
    deletedToggleHide: "Hide deleted ({count})",
    restoreErrorPrefix: "Restore error: ",
    searching: "Searching…",
    noUnansweredQuestions: "No unanswered questions.",
    deleteActionLabel: "Delete",
    compareToggleOn: "Compare documents",
    compareToggleOff: "Cancel comparison",
    compareSelectHint: "Select 2–3 documents to compare ({count}/3 selected).",
    compareRunLabel: "Compare ({count})",
    comparing: "Comparing…",
    compareErrorPrefix: "Comparison error: ",
    compareResultsTitle: "Comparison results",
    compareResultsSubtitle: "Comparing: {titles}",
    noContradictionsFound: "No contradictions found between these documents.",
    contradictionFindings: "Contradiction findings",
    noContradictionFindings: "No contradictions found yet.",
    deleteErrorPrefix: "Delete error: ",
    notFoundDefault: "Not found",
    chunksCountSuffix: "{count} chunks",
    viewLiveLink: " · View live →",
    publishing: "Publishing…",
    publishErrorPrefix: "Publish error: ",
    confirmDeleteDoc: 'Delete the document "{title}"? You can restore it later.',
    editDocTitle: "Edit document",
    newDocTitle: "New document",
    titlePlaceholder: "Title (e.g. Leave policy)",
    uploadLimitHint: "Maximum: ~8,000 words or 2MB",
    previewLabel: "Preview (how it will look in the real article)",
    livePreviewEmpty: "The preview will appear here as you type…",
    sourceUrlPlaceholder: "sourceUrl (optional)",
    updateBtn: "Update",
    saveAsDraftBtn: "Save as draft",
    saveDraftHint: 'You\'ll need to press "Publish" afterwards to make it live.',
    confirmAndSave: "Confirm & Save",
    backToEdit: "← Back to editing",
    needTitleError: "❌ Write a title first.",
    checkingExistingDoc: "Checking existing document…",
    noTextChanges: "No changes to the text.",
    willBeSavedAs: "Will be saved as: {slug}",
    uploading: "Uploading…",
    sourceScoreLabel: "Source: {title} · relevance {pct}%",
    technicalDetails: "Technical details",

    // widget settings
    widgetSettings: "⚙ Widget settings",
    widgetSettingsIntro: "Customize how the assistant looks, and get notified when it can't answer something.",
    botNameLabel: "Bot name",
    accentColorLabel: "Accent color",
    logoUrlLabel: "Logo URL (optional)",
    notifyEmailLabel: "Notification email (optional)",
    notifyEmailHint: "You'll get an email when the assistant can't answer a question (at most once per hour).",
    saveSettingsBtn: "Save settings",
    settingsSaved: "✓ Settings saved.",
    settingsSaveErrorPrefix: "Save error: ",
    settingsLoadError: "Could not load settings.",
    widgetSettingsTooltip: "Widget settings",

    // human handoff (Section J)
    contactSectionTitle: "Human contact",
    contactSectionIntro: "Shown to visitors when the assistant can't answer, so they always have a way to reach you.",
    contactLabelLabel: "Button text",
    contactLabelPlaceholder: "e.g. Chat with us on WhatsApp",
    contactUrlLabel: "Contact link (optional)",
    contactUrlPlaceholder: "https://wa.me/30... or mailto:you@example.com",
    contactUrlHint: "Any link works: WhatsApp, email, Messenger, your contact page.",
    contactPhoneLabel: "Phone number (optional)",
    contactPhonePlaceholder: "+30 210 1234567",

    // embed layer (Section I)
    embedTooltip: "Embed on your site",
    embedTitle: "🔗 Embed on your site",
    embedIntro: "Add your website's domain, and you'll get a ready-to-paste script tag for your bot.",
    embedDomainPlaceholder: "yourdomain.gr",
    embedAddDomainBtn: "Add",
    embedRemoveDomainAria: "Remove domain",
    embedNoDomainsHint: "Add at least one domain to get your embed script.",
    embedScriptLabel: "Paste this in your site's HTML:",
    embedCopyBtn: "Copy",
    embedCopiedMsg: "✓ Copied.",
    embedLoadError: "Could not load embed settings.",
    embedSaveErrorPrefix: "Save error: ",
    embedDomainEmptyError: "Enter a domain first.",
    embedScriptRefreshHint: "If you change the assistant's name, color, or contact info later, copy this script again to update it on your site.",

    // analytics (Section K)
    analyticsTooltip: "Analytics",
    analyticsTitle: "📊 Analytics",
    analyticsIntro: "See how many questions your assistant answers, and how many it couldn't.",
    totalQuestionsLabel: "Total questions",
    totalFallbackLabel: "Unanswered",
    fallbackRateLabel: "Unanswered rate",
    analytics7Days: "7 days",
    analytics30Days: "30 days",
    analytics90Days: "90 days",
    analyticsLoadError: "Could not load analytics.",
    analyticsNoData: "No questions yet in this period.",
    analyticsChartCaption: "Daily questions (red = unanswered)",
  },
  el: {
    loading: "Φόρτωση…",
    cancel: "Άκυρο",
    switchMode: "Αλλαγή λειτουργίας",
    manageContent: "Διαχείριση περιεχομένου",
    updatedPrefix: "Ενημερώθηκε",
    loadErrorPrefix: "Σφάλμα φόρτωσης: ",
    genericErrorPrefix: "Σφάλμα: ",
    noResults: "Κανένα αποτέλεσμα.",
    draftBadge: "Πρόχειρο",
    edit: "Επεξεργασία",
    publish: "Δημοσίευση",
    delete: "Διαγραφή",
    restore: "Επαναφορά",
    noDocsYet: "Δεν υπάρχουν έγγραφα ακόμα.",
    expiresToday: "Λήγει σήμερα",
    expiresInDay: "Λήγει σε {days} ημέρα",
    expiresInDays: "Λήγει σε {days} ημέρες",

    landingDocTitle: "Operations Portal — Καλωσόρισες",
    landingIntro: "Πριν συνεχίσεις, διάλεξε πώς θα μπεις.",
    devTitle: "Developer",
    devDesc: "Πρόσβαση στο πραγματικό workspace περιεχομένου (χρειάζεται κωδικό).",
    guestTitle: "Επισκέπτης / Guest",
    guestDesc: "Δοκίμασε ελεύθερα το εργαλείο σε έναν δικό σου, ξεχωριστό χώρο. Ό,τι ανεβάσεις δεν το βλέπει κανείς άλλος, και σβήνεται μόνο του μετά από 7 μέρες.",
    accountTitle: "Λογαριασμός",
    accountDesc: "Κάνε εγγραφή ή σύνδεση στον δικό σου μόνιμο χώρο εργασίας, από οποιαδήποτε συσκευή.",
    signupTab: "Εγγραφή",
    loginTab: "Σύνδεση",
    emailLabel: "Email",
    passwordLabel: "Κωδικός",
    signupBtn: "Εγγραφή",
    devPasswordLabel: "Κωδικός Developer",
    login: "Είσοδος",
    checking: "Έλεγχος…",
    wrongPassword: "Λάθος κωδικός.",
    connectionErrorPrefix: "Σφάλμα σύνδεσης: ",

    indexDocTitle: "Operations Portal — Βοηθός",
    recentDocs: "Πρόσφατα έγγραφα",
    hostIntro: "Διαδικασίες και πολιτικές της εταιρείας. Κάνε κλικ σε ένα έγγραφο για να το διαβάσεις, ή ρώτησε τον βοηθό κάτω-δεξιά.",
    noDocsInWorkspace: "Δεν υπάρχουν έγγραφα ακόμα σε αυτόν τον χώρο εργασίας.",
    docsLoadError: "Σφάλμα φόρτωσης εγγράφων.",
    assistantTitle: "Βοηθός",
    conversation: "Συνομιλία",
    askPlaceholder: "Ρώτησε κάτι…",
    send: "Στείλε",
    answerFrom: "Η απάντηση προέρχεται από: ",
    viewArticle: "Δες το άρθρο →",

    articleDocTitle: "Άρθρο — Βοηθός Τεκμηρίωσης",
    noDocIdFound: "Δεν βρέθηκε αναγνωριστικό εγγράφου.",
    docNotFound: "Το έγγραφο δεν βρέθηκε.",
    docNotPublished: "Αυτό το έγγραφο δεν έχει δημοσιευτεί ακόμα.",
    updatedColon: "Ενημερώθηκε:",

    editorDocTitle: "Διαχείριση Περιεχομένου — Operations Portal",
    editorHeading: "Διαχείριση Περιεχομένου",
    newDoc: "+ Νέο έγγραφο",
    filterByTitle: "Φίλτρο με τίτλο…",
    documentsLabel: "Έγγραφα",
    allDocs: "Όλα τα έγγραφα",
    backToAllDocs: "← Όλα τα έγγραφα",
    searchByDescription: "Βρες με περιγραφή",
    searchExamplePlaceholder: "π.χ. τα ωράρια του Billing…",
    testQuestion: "Δοκιμαστικό ερώτημα",
    testQuestionPlaceholder: "π.χ. Ποιο είναι το όριο έγκρισης;",
    unansweredQuestions: "Ερωτήσεις χωρίς απάντηση",
    refresh: "↻ Ανανέωση",
    deletedToggleShow: "Δες διαγραμμένα ({count})",
    deletedToggleHide: "Απόκρυψη διαγραμμένα ({count})",
    restoreErrorPrefix: "Σφάλμα επαναφοράς: ",
    searching: "Αναζήτηση…",
    noUnansweredQuestions: "Καμία ερώτηση χωρίς απάντηση.",
    deleteActionLabel: "Διαγραφή",
    compareToggleOn: "Σύγκριση εγγράφων",
    compareToggleOff: "Ακύρωση σύγκρισης",
    compareSelectHint: "Επίλεξε 2–3 έγγραφα για σύγκριση ({count}/3 επιλεγμένα).",
    compareRunLabel: "Σύγκριση ({count})",
    comparing: "Σύγκριση…",
    compareErrorPrefix: "Σφάλμα σύγκρισης: ",
    compareResultsTitle: "Αποτελέσματα σύγκρισης",
    compareResultsSubtitle: "Σύγκριση: {titles}",
    noContradictionsFound: "Δεν βρέθηκαν αντιφάσεις ανάμεσα σε αυτά τα έγγραφα.",
    contradictionFindings: "Ευρήματα αντιφάσεων",
    noContradictionFindings: "Δεν έχουν βρεθεί αντιφάσεις ακόμα.",
    deleteErrorPrefix: "Σφάλμα διαγραφής: ",
    notFoundDefault: "Δεν βρέθηκε",
    chunksCountSuffix: "{count} τμήματα",
    viewLiveLink: " · Δες live →",
    publishing: "Δημοσίευση…",
    publishErrorPrefix: "Σφάλμα δημοσίευσης: ",
    confirmDeleteDoc: 'Διαγραφή του εγγράφου "{title}"; Μπορείς να το επαναφέρεις αργότερα.',
    editDocTitle: "Επεξεργασία εγγράφου",
    newDocTitle: "Νέο έγγραφο",
    titlePlaceholder: "Τίτλος (π.χ. Πολιτική αδειών)",
    uploadLimitHint: "Μέγιστο: ~8.000 λέξεις ή 2MB",
    previewLabel: "Προεπισκόπηση (πώς θα φανεί στο πραγματικό άρθρο)",
    livePreviewEmpty: "Η προεπισκόπηση θα εμφανιστεί εδώ καθώς γράφεις…",
    sourceUrlPlaceholder: "sourceUrl (προαιρετικό)",
    updateBtn: "Ενημέρωση",
    saveAsDraftBtn: "Αποθήκευση ως πρόχειρο",
    saveDraftHint: 'Θα χρειαστεί να πατήσεις "Δημοσίευση" μετά, για να γίνει ζωντανό.',
    confirmAndSave: "Επιβεβαίωση & Αποθήκευση",
    backToEdit: "← Πίσω για επεξεργασία",
    needTitleError: "❌ Γράψε έναν τίτλο πρώτα.",
    checkingExistingDoc: "Έλεγχος υπάρχοντος εγγράφου…",
    noTextChanges: "Καμία αλλαγή στο κείμενο.",
    willBeSavedAs: "Θα αποθηκευτεί ως: {slug}",
    uploading: "Ανέβασμα…",
    sourceScoreLabel: "Πηγή: {title} · σχετικότητα {pct}%",
    technicalDetails: "Τεχνικές λεπτομέρειες",

    // widget settings
    widgetSettings: "⚙ Ρυθμίσεις widget",
    widgetSettingsIntro: "Προσάρμοσε την εμφάνιση του βοηθού, και μάθε πότε δεν μπορεί να απαντήσει κάτι.",
    botNameLabel: "Όνομα bot",
    accentColorLabel: "Χρώμα",
    logoUrlLabel: "URL λογότυπου (προαιρετικό)",
    notifyEmailLabel: "Email ειδοποιήσεων (προαιρετικό)",
    notifyEmailHint: "Θα λαμβάνεις email όταν ο βοηθός δεν μπορεί να απαντήσει σε μια ερώτηση (το πολύ μία φορά την ώρα).",
    saveSettingsBtn: "Αποθήκευση ρυθμίσεων",
    settingsSaved: "✓ Οι ρυθμίσεις αποθηκεύτηκαν.",
    settingsSaveErrorPrefix: "Σφάλμα αποθήκευσης: ",
    settingsLoadError: "Δεν ήταν δυνατή η φόρτωση ρυθμίσεων.",
    widgetSettingsTooltip: "Ρυθμίσεις widget",

    // human handoff (Section J)
    contactSectionTitle: "Επικοινωνία με άνθρωπο",
    contactSectionIntro: "Εμφανίζεται στους επισκέπτες όταν ο βοηθός δεν μπορεί να απαντήσει, ώστε να έχουν πάντα τρόπο να σε βρουν.",
    contactLabelLabel: "Κείμενο κουμπιού",
    contactLabelPlaceholder: "π.χ. Μίλα μαζί μας στο WhatsApp",
    contactUrlLabel: "Link επικοινωνίας (προαιρετικό)",
    contactUrlPlaceholder: "https://wa.me/30... ή mailto:you@example.com",
    contactUrlHint: "Οποιοδήποτε link δουλεύει: WhatsApp, email, Messenger, η σελίδα επικοινωνίας σου.",
    contactPhoneLabel: "Τηλέφωνο (προαιρετικό)",
    contactPhonePlaceholder: "+30 210 1234567",

    // embed layer (Section I)
    embedTooltip: "Embed στο site σου",
    embedTitle: "🔗 Embed στο site σου",
    embedIntro: "Πρόσθεσε το domain του site σου, και θα πάρεις ένα έτοιμο script tag για τον βοηθό σου.",
    embedDomainPlaceholder: "yourdomain.gr",
    embedAddDomainBtn: "Προσθήκη",
    embedRemoveDomainAria: "Αφαίρεση domain",
    embedNoDomainsHint: "Πρόσθεσε τουλάχιστον ένα domain για να πάρεις το embed script.",
    embedScriptLabel: "Επικόλλησε αυτό στο HTML του site σου:",
    embedCopyBtn: "Αντιγραφή",
    embedCopiedMsg: "✓ Αντιγράφηκε.",
    embedLoadError: "Δεν ήταν δυνατή η φόρτωση ρυθμίσεων embed.",
    embedSaveErrorPrefix: "Σφάλμα αποθήκευσης: ",
    embedDomainEmptyError: "Γράψε πρώτα ένα domain.",
    embedScriptRefreshHint: "Αν αλλάξεις το όνομα, το χρώμα, ή τα στοιχεία επικοινωνίας του βοηθού αργότερα, αντίγραψε ξανά αυτό το script για να ενημερωθεί στο site σου.",

    // analytics (Section K)
    analyticsTooltip: "Analytics",
    analyticsTitle: "📊 Analytics",
    analyticsIntro: "Δες πόσες ερωτήσεις απαντάει ο βοηθός σου, και πόσες όχι.",
    totalQuestionsLabel: "Σύνολο ερωτήσεων",
    totalFallbackLabel: "Χωρίς απάντηση",
    fallbackRateLabel: "Ποσοστό χωρίς απάντηση",
    analytics7Days: "7 ημέρες",
    analytics30Days: "30 ημέρες",
    analytics90Days: "90 ημέρες",
    analyticsLoadError: "Δεν ήταν δυνατή η φόρτωση στατιστικών.",
    analyticsNoData: "Καμία ερώτηση ακόμα σε αυτή την περίοδο.",
    analyticsChartCaption: "Ερωτήσεις ανά ημέρα (κόκκινο = χωρίς απάντηση)",
  },
};

// Χρόνος/ημερομηνία -- ξεχωριστά λεξικά (χρειάζονται πληθυντικό/ενικό, όχι
// απλά μία μετάφραση λέξη-προς-λέξη).
const TIME_UNIT_LABELS = {
  en: { justNow: "just now", min: "minute", mins: "minutes", hour: "hour", hours: "hours",
        day: "day", days: "days", month: "month", months: "months", year: "year", years: "years",
        ago: "{n} {unit} ago" },
  el: { justNow: "μόλις τώρα", min: "λεπτό", mins: "λεπτά", hour: "ώρα", hours: "ώρες",
        day: "μέρα", days: "μέρες", month: "μήνα", months: "μήνες", year: "χρόνο", years: "χρόνια",
        ago: "πριν {n} {unit}" },
};

const MONTH_LABELS = {
  en: ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"],
  el: ["Ιαν","Φεβ","Μαρ","Απρ","Μαι","Ιουν","Ιουλ","Αυγ","Σεπ","Οκτ","Νοε","Δεκ"],
};

function getLang() {
  const stored = localStorage.getItem("uiLang");
  return stored === "el" || stored === "en" ? stored : "en";
}

function setLang(lang) {
  localStorage.setItem("uiLang", lang);
}

// t("key", {name: value}) -- επιστρέφει το μεταφρασμένο string για την
// τρέχουσα γλώσσα, με προαιρετική αντικατάσταση {placeholders}. Αν λείπει
// το key από τη γλώσσα, πέφτει πίσω στα Αγγλικά, και μετά στο ίδιο το key
// (ποτέ crash, ποτέ άδειο κείμενο).
function t(key, vars) {
  const lang = getLang();
  const dict = TRANSLATIONS[lang] || TRANSLATIONS.en;
  let str = dict[key] != null ? dict[key] : (TRANSLATIONS.en[key] != null ? TRANSLATIONS.en[key] : key);
  if (vars) {
    for (const name in vars) {
      str = str.split("{" + name + "}").join(vars[name]);
    }
  }
  return str;
}

// Εφαρμόζει τις μεταφράσεις σε όλο το στατικό HTML που έχει data-i18n
// attributes -- καλείται μία φορά στο load κάθε σελίδας. Το δυναμικό
// περιεχόμενο (λίστες, chat μηνύματα κ.λπ.) καλεί το t() απευθείας μέσα
// στο δικό του JS, δεν περνάει από εδώ.
function applyTranslations(root) {
  root = root || document;
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.getAttribute("data-i18n"));
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.getAttribute("data-i18n-placeholder"));
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    const label = t(el.getAttribute("data-i18n-title"));
    el.title = label;
    el.setAttribute("aria-label", label);
  });
  const docTitleKey = document.documentElement.getAttribute("data-i18n-doctitle");
  if (docTitleKey) document.title = t(docTitleKey);
  document.documentElement.lang = getLang();
}

// Στήνει το κουμπί εναλλαγής γλώσσας (EN | GR). Στο κλικ, αποθηκεύει τη
// νέα γλώσσα και ξαναφορτώνει τη σελίδα -- σκόπιμα ΟΧΙ ζωντανή εναλλαγή,
// ώστε όλο το δυναμικό περιεχόμενο (που ήδη περνάει από t() στο δικό του
// render) να ξαναφτιαχτεί σωστά από την αρχή, χωρίς ρίσκο μισής ενημέρωσης.
function initLangToggle(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const current = getLang();
  container.querySelectorAll(".lang-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.lang === current);
    btn.addEventListener("click", () => {
      if (btn.dataset.lang === current) return;
      setLang(btn.dataset.lang);
      window.location.reload();
    });
  });
}

// "3 minutes ago" / "πριν 3 λεπτά" κ.λπ. -- για να διαβάζεται εύκολα η
// λίστα εγγράφων στο editor, χωρίς ωμές ημερομηνίες ISO.
function timeAgo(iso) {
  if (!iso) return "";
  const L = TIME_UNIT_LABELS[getLang()] || TIME_UNIT_LABELS.en;
  const fmt = (n, singular, plural) => L.ago.replace("{n}", n).replace("{unit}", n === 1 ? singular : plural);

  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return L.justNow;
  if (mins < 60) return fmt(mins, L.min, L.mins);
  const hours = Math.floor(mins / 60);
  if (hours < 24) return fmt(hours, L.hour, L.hours);
  const days = Math.floor(hours / 24);
  if (days < 30) return fmt(days, L.day, L.days);
  const months = Math.floor(days / 30);
  if (months < 12) return fmt(months, L.month, L.months);
  const years = Math.floor(months / 12);
  return fmt(years, L.year, L.years);
}

// "Expires in 3 days" / "Λήγει σε 3 ημέρες" -- μόνο για έγγραφα επισκεπτών
// (workspaces εκτός του προστατευμένου), όπου κάθε ανενεργό έγγραφο έχει
// αυτόματη λήξη. Επιστρέφει null όταν δεν υπάρχει expiresAt, ώστε το
// frontend να μη δείξει τίποτα.
function expiryLabel(expiresAt) {
  if (!expiresAt) return null;
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  const days = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
  if (days === 0) return t("expiresToday");
  return t(days === 1 ? "expiresInDay" : "expiresInDays", { days });
}

// Μία κοινή, γλωσσο-ευαίσθητη μορφοποίηση ημερομηνίας -- χρησιμοποιείται
// στο article.html (πριν είχε το δικό του, ξεχωριστό αντίγραφο).
function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  const months = MONTH_LABELS[getLang()] || MONTH_LABELS.en;
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()}`;
}