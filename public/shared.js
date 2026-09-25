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
// Επιπλέον σημείωση: παλιότερα υπήρχε εδώ και ΔΕΥΤΕΡΟ επίπεδο ασφάλειας --
// ένα flag στο sessionStorage που σταματούσε το redirect μετά την πρώτη
// προσπάθεια μέσα στο ίδιο tab, "για κάθε ενδεχόμενο". Αφαιρέθηκε: αντί να
// προστατεύει από κάτι, δημιουργούσε το δικό του πραγματικό bug -- αν ο
// επισκέπτης ξαναγύριζε στη ρίζα (π.χ. πλοήγηση πίσω, bookmark, νέο
// πληκτρολόγημα του URL) μέσα στο ίδιο tab ΧΩΡΙΣ ποτέ να έχει αποκτήσει
// workspaceId, το flag ήταν ήδη σημειωμένο και ΔΕΝ ξανάκανε redirect --
// έμενε "κολλημένος" στο index.html, με WORKSPACE_ID null, δείχνοντας άδειο
// "no documents" αντί να τον στείλει στη landing page. Βρέθηκε σε ζωντανή
// χρήση, Σεπτέμβριος 2026. Η πρωτεύουσα προστασία (__IS_LANDING_PAGE__,
// παραπάνω) είναι αρκετή από μόνη της -- δεν χρειάζεται δεύτερο επίπεδο.
//
// __SKIP_WORKSPACE_REDIRECT__: ξεχωριστό, γενικότερο flag από το
// __IS_LANDING_PAGE__ -- για σελίδες που ΔΕΝ είναι η landing page αλλά ΔΕΝ
// χρειάζονται ποτέ κανένα workspace (π.χ. terms.html, privacy.html, καθαρά
// στατικό/δημόσιο περιεχόμενο, όχι ειδικό ανά-workspace). Χωρίς αυτό, ένας
// πρωτοεπισκέπτης που φτάνει απευθείας σε /terms.html (π.χ. από email,
// footer link, πριν καν διαλέξει Guest/Account) ανακατευθυνόταν στη landing
// page αντί να δει τους όρους. Βρέθηκε σε ζωντανή χρήση, Σεπτέμβριος 2026,
// αμέσως μετά την αφαίρεση του παραπάνω sessionStorage guard -- το guard
// έκρυβε εν μέρει αυτό το ίδιο πρόβλημα κατά τύχη (η δεύτερη επίσκεψη σε
// terms.html στο ίδιο tab έδειχνε σωστά, επειδή το flag είχε ήδη
// "καταναλωθεί" από κάποιο προηγούμενο redirect, όχι επίτηδες).
function resolveWorkspaceId() {
  const stored = localStorage.getItem("workspaceId");
  if (stored) return stored;

  if (window.__IS_LANDING_PAGE__ || window.__SKIP_WORKSPACE_REDIRECT__) return null;

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

// Μικρή indirection γύρω από το window.location.href = ... -- χωρίς αυτό,
// headless DOM tests (jsdom) δεν μπορούν να επαληθεύσουν top-level
// navigation, αφού το window.location δεν είναι επαναπροσδιορίσιμο εκεί.
// Παραγωγικά συμπεριφέρεται ακριβώς ίδια, απλά με ένα function call ανάμεσα.
function navigateTo(url) {
  window.location.href = url;
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
// --- formatAnswer (Βήμα 2δ) -- ΑΡΧΗ ---
// Ελάχιστος και ΑΣΦΑΛΗΣ μορφοποιητής markdown για τις απαντήσεις (Βήμα 2δ). Το Gemini
// γράφει λίστες (`* κείμενο`, `1. κείμενο`), πλάγια (`*κείμενο*`) και έντονα (`**κείμενο**`).
// ΙΔΙΑ λογική στο widget.js και στο shared.js (demo σελίδα, test panel του editor).
// Πρώτα ξεφεύγουν ΟΛΟΙ οι ειδικοί χαρακτήρες HTML και μετά προστίθενται μόνο οι δικές μας
// ετικέτες (strong, em, ul, ol, li, br): τίποτα από το κείμενο δεν γίνεται ποτέ ετικέτα.
// Ημιτελές markdown (π.χ. ένα `**` που δεν έκλεισε ακόμα ενώ γίνεται streaming) μένει
// σαν κείμενο μέχρι να ολοκληρωθεί, χωρίς σφάλμα.
function formatInline(s) {
  return s
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>");
}

function formatAnswer(text) {
  var lines = escapeHtml(text).replace(/\r\n?/g, "\n").split("\n");
  var blocks = []; // { kind: "p" | "list", html }
  var para = [];
  var list = null; // { type: "ul" | "ol", start, items: [{ html, children: [] }] }

  function flushPara() {
    if (para.length) {
      blocks.push({ kind: "p", html: para.join("<br>") });
      para = [];
    }
  }
  function flushList() {
    if (!list) return;
    var html = "<" + list.type + (list.type === "ol" && list.start > 1 ? ' start="' + list.start + '"' : "") + ">";
    list.items.forEach(function (item) {
      html += "<li>" + item.html;
      if (item.children.length) {
        html += "<ul>" + item.children.map(function (c) { return "<li>" + c + "</li>"; }).join("") + "</ul>";
      }
      html += "</li>";
    });
    blocks.push({ kind: "list", html: html + "</" + list.type + ">" });
    list = null;
  }

  lines.forEach(function (line) {
    if (!line.trim()) {
      flushPara();
      flushList();
      return;
    }
    var bullet = /^(\s*)[*\-\u2022]\s+(\S.*)$/.exec(line);
    var numbered = bullet ? null : /^(\s*)(\d{1,2})[.)]\s+(\S.*)$/.exec(line);
    var heading = bullet || numbered ? null : /^\s{0,3}#{1,6}\s+(\S.*)$/.exec(line);

    if (bullet) {
      // Εσοχή 2+ χαρακτήρων μέσα σε υπάρχουσα λίστα = υπο-κουκκίδα (ένα επίπεδο).
      if (bullet[1].length >= 2 && list && list.items.length) {
        list.items[list.items.length - 1].children.push(formatInline(bullet[2]));
        return;
      }
      flushPara();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", start: 1, items: [] };
      }
      list.items.push({ html: formatInline(bullet[2]), children: [] });
    } else if (numbered) {
      flushPara();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", start: parseInt(numbered[2], 10), items: [] };
      }
      list.items.push({ html: formatInline(numbered[3]), children: [] });
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "p", html: "<strong>" + formatInline(heading[1]) + "</strong>" });
    } else {
      flushList();
      para.push(formatInline(line.trim()));
    }
  });
  flushPara();
  flushList();

  // Κενή γραμμή ανάμεσα σε δύο παραγράφους = οπτικός διαχωρισμός (όπως πριν)· γύρω από λίστες
  // αρκούν τα περιθώρια του CSS.
  var out = "";
  blocks.forEach(function (b, i) {
    if (i > 0 && b.kind === "p" && blocks[i - 1].kind === "p") out += "<br><br>";
    out += b.html;
  });
  return out;
}
// --- formatAnswer (Βήμα 2δ) -- ΤΕΛΟΣ ---

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
  if (typeof DOMPurify === "undefined") {
    // Fail CLOSED, όχι ανοιχτά: αν το DOMPurify CDN δεν φόρτωσε (δίκτυο,
    // ad-blocker, firewall), ΔΕΝ δείχνουμε το ακατέργαστο, μη-καθαρισμένο
    // HTML του marked.js (το marked δεν κάνει sanitize μόνο του -- θα ήταν
    // πιθανό XSS, ειδικά σε περιεχόμενο από URL sync/Google Drive import,
    // όχι πλήρως ελεγμένη πηγή). Δείχνουμε απλό, escaped κείμενο αντί για
    // μορφοποιημένο. Βρέθηκε σε πλήρες audit, Σεπτέμβριος 2026.
    return escapeHtml(text).replace(/\n/g, "<br>");
  }
  return DOMPurify.sanitize(html);
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
    switchMode: "Log out",
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

    // Section Q: pricing tiers -- μήνυμα προς τον ΤΕΛΙΚΟ επισκέπτη όταν
    // εξαντλείται το μηνιαίο όριο μηνυμάτων του πελάτη (index.html/widget.js),
    // και μήνυμα προς τον ΙΔΙΟΚΤΗΤΗ workspace στο editor.html όταν το δει.
    // Σκόπιμα γενικό προς τον επισκέπτη -- καμία αναφορά σε Idmon, tiers,
    // ή όρια, όπως είχε συμφωνηθεί.
    limitReachedMessage: "We're experiencing technical difficulties right now. Please contact us directly:",
    usageLimitBannerText: "You've reached this month's message limit for your plan. Visitors are seeing a generic \"technical difficulties\" message instead of answers until next month, or until you upgrade.",
    upgradeBtn: "Upgrade",
    upgradeTitle: "Upgrade your plan",
    upgradeIntro: "Pick the plan that fits your workspace. Your new limits apply as soon as the payment is confirmed.",
    upgradeCurrentPlan: "Current plan: {plan}",
    upgradeChoosePlan: "Choose {plan}",
    upgradeMessagesPerMonth: "{n} messages / month",
    upgradeDocsCount: "{n} documents",
    upgradeDocsUnlimited: "Unlimited documents",
    upgradePerMonth: "/ month",
    upgradePerYear: "/ year",
    upgradePeriodMonthly: "Monthly",
    upgradePeriodAnnual: "Annual",
    checkoutIntentUnavailable: "That plan can't be bought for this account right now. If you already have a subscription, use the buttons at the top to manage it or switch to Pro.",
    upgradePoweredBy: "Payments are handled securely by Paddle.",
    upgradeLoadError: "Couldn't open the payment window. Please try again in a moment.",
    upgradeProcessing: "Payment received. Your plan is being updated, this usually takes a few seconds.",
    upgradeDone: "All set. Your plan is now {plan}.",
    upgradeSlow: "This is taking longer than usual. Your payment went through, so please refresh the page in a minute.",
    planName_free: "Free",
    planName_basic: "Basic",
    planName_pro: "Pro",
    upgradePendingTitle: "Activating your plan",
    upgradeDoneTitle: "Your plan is now {plan}",
    upgradeDoneText: "Your new limits are already active. Thank you!",
    upgradeBackToDocs: "Back to documents",
    upgradePaymentFailed: "The payment didn't go through. You can try again or use another card.",
    paymentPendingBanner: "Your payment is being processed. Your plan will update in a moment.",
    manageSubBtn: "Manage subscription",
    changePlanBtn: "Switch to Pro",
    changePlanTitle: "Switch to Pro",
    changePlanLoading: "Calculating what you'll pay...",
    changePlanIntro: "You keep your current subscription and only pay the difference for the rest of this billing period.",
    changePlanTodayLabel: "Charged today",
    changePlanTodayNote: "for the rest of your current billing period, tax included",
    changePlanRecurringFrom: "From {date}: {amount} / month",
    changePlanRecurringThen: "Then {amount} / month",
    changePlanRecurringFromYear: "From {date}: {amount} / year",
    changePlanRecurringThenYear: "Then {amount} / year",
    changePlanConfirm: "Confirm and pay {amount}",
    changePlanCancel: "Cancel",
    changePlanRetry: "Try again",
    changePlanWorking: "Switching your plan...",
    changePlanErrLockedRenewal: "Your subscription is about to renew, so it can't be changed right now. Please try again in about half an hour.",
    changePlanErrPendingChanges: "There is already a pending change on your subscription (for example a scheduled cancellation). You can review it from Manage subscription.",
    changePlanErrPastDue: "Your last payment didn't go through. Please update your payment method from Manage subscription first.",
    changePlanErrFailed: "The change couldn't be completed and your plan has not been changed. Please check your payment method and try again.",
    changePlanErrNotEligible: "This change isn't available for your account.",
    changePlanErrUnknown: "We couldn't confirm the change right now. Please refresh the page in a minute to see your current plan, and try again if it hasn't changed.",
    portalError: "We couldn't open the billing page. Please try again in a moment.",

    // landing.html
    landingDocTitle: "Idmon — Welcome",
    landingIntro: "Choose how you'd like to sign in.",
    checkoutIntentNote: "Create your account (or log in) to continue to {plan}, {period}. The payment window opens right after.",
    checkoutIntentPeriod_monthly: "monthly",
    checkoutIntentPeriod_annual: "annual",
    guestTitle: "Guest",
    guestDesc: "Freely try the tool in your own separate space. Nobody else sees what you upload, and it's automatically deleted after 7 days.",
    accountTitle: "Account",
    accountDesc: "Sign up or log in to your own permanent workspace, from any device.",
    signupTab: "Sign up",
    loginTab: "Log in",
    orDivider: "or",
    emailLabel: "Email",
    passwordLabel: "Password",
    signupBtn: "Sign up",
    devPasswordLabel: "Developer password",
    login: "Log in",
    checking: "Checking…",
    wrongPassword: "Wrong password.",
    connectionErrorPrefix: "Connection error: ",
    turnstileRequired: "Please complete the verification and try again.",
    forgotLink: "Forgot password?",
    sendResetLink: "Send reset link",
    forgotSuccessMessage: "If that email is registered, a reset link has been sent.",
    newPasswordLabel: "New password",
    confirmPasswordLabel: "Confirm new password",
    confirmPasswordSignupLabel: "Confirm password",
    setNewPasswordBtn: "Set new password",
    passwordTooShort: "Password must be at least 8 characters.",
    passwordsDontMatch: "Passwords don't match.",
    termsLink: "Terms of Service",
    privacyLink: "Privacy Policy",
    verifyingEmail: "Verifying your email…",
    continueToApp: "Continue",
    emailVerifiedSuccess: "Your email is verified! You can now continue.",
    verifyBannerText: "Please verify your email address.",
    resendVerificationLink: "Resend verification email",
    verificationEmailSent: "Sent! Check your inbox.",
    accountSectionTitle: "Account",
    exportDataBtn: "Export my data",
    deleteAccountBtn: "Delete my account",
    deleteAccountWarning: "This permanently deletes your account, all documents, and settings. This cannot be undone.",
    confirmDeleteAccountBtn: "Permanently delete",
    deleteAccountPasswordRequired: "Enter your password to confirm.",

    // index.html
    indexDocTitle: "Idmon — Assistant",
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
    editorDocTitle: "Content Management — Idmon",
    editorHeading: "Content Management",
    newDoc: "+ New document",
    filterByTitle: "Filter by title…",
    documentsLabel: "Documents",
    allDocs: "All documents",
    searchByDescription: "Find by description",
    searchExamplePlaceholder: "e.g. Billing's working hours…",
    testQuestion: "Test question",
    testQuestionPlaceholder: "e.g. What's the approval limit?",
    testQGenericErrorMessage: "Something went wrong. Please try again in a moment.",
    testQNewConversation: "New conversation",
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
    topQuestionsTitle: "Most common questions",
    topQuestionsEmpty: "Not enough data yet to show common questions.",

    // URL sync (Section M)
    addFromUrlBtn: "🔗 Add from URL",
    addFromUrlTitle: "🔗 Add document from URL",
    addFromUrlIntro: "Paste a link to a public page (e.g. your FAQ or policies page), and we'll read it for you -- no need to copy-paste the text yourself.",
    urlLabel: "Page URL",
    titleOptionalLabel: "Title (optional)",
    titleOptionalPlaceholder: "Leave empty to use the page's own title",
    addFromUrlSubmitBtn: "Fetch page",
    addingFromUrl: "Fetching…",
    urlRequiredError: "Enter a URL first.",
    addFromUrlErrorPrefix: "Could not add from URL: ",
    uploadFileBtn: "📤 Upload file",
    uploadFileTitle: "📤 Upload a file",
    uploadFileIntro: "Upload a .txt, .md, or .pdf file and we'll extract the text for you -- no need to copy-paste it yourself.",
    fileLabel: "File",
    uploadFileSubmitBtn: "Upload",
    uploadingFile: "Uploading…",
    fileRequiredError: "Choose a file first.",
    uploadFileErrorPrefix: "Could not upload file: ",
    refreshFromUrl: "↻ Refresh from URL",

    // Google Drive connector (Section N)
    googleDriveBtn: "Google Drive",
    googleDriveTitle: "Import from Google Drive",
    googleDriveConnectIntro: "Connect your Google Drive account to import Google Docs and Sheets directly, without copy-pasting.",
    googleDriveConnectBtn: "Connect Google Drive",
    googleDriveConnectedAs: "Connected as {email}",
    googleDriveChangeAccountBtn: "Change account",
    googleDriveDisconnectBtn: "Disconnect",
    googleDriveDisconnecting: "Disconnecting…",
    googleDriveDisconnectErrorPrefix: "Could not disconnect: ",
    googleDriveLoadError: "Could not load your Google Drive files.",
    googleDriveNoFiles: "No Google Docs or Sheets found in your Drive.",
    googleDriveModifiedPrefix: "Modified",
    googleDriveImportBtn: "Import selected ({count})",
    googleDriveImporting: "Importing…",
    googleDriveImportErrorPrefix: "Import failed: ",
    googleDriveImportSummary: "Imported {success} of {total} files as drafts.",
    googleDriveImportFailedPrefix: "Could not import: ",
    googleDriveConnectedBanner: "✓ Google Drive connected successfully.",
    googleDriveErrorDenied: "Google sign-in was cancelled.",
    googleDriveErrorMissingParams: "Something went wrong during sign-in. Please try again.",
    googleDriveErrorInvalidState: "This sign-in link expired. Please try connecting again.",
    googleDriveErrorTokenExchangeFailed: "Google sign-in failed. Please try again.",
    googleDriveErrorNoRefreshToken: "Please try connecting again and approve full access when asked.",
    googleDriveErrorMissingScope: "Google Drive access wasn't granted. Please try connecting again and make sure the Google Drive checkbox is checked before continuing.",
    googleDriveErrorGeneric: "Something went wrong connecting to Google Drive.",
    refreshingFromUrl: "Refreshing…",
    refreshFromUrlErrorPrefix: "Refresh error: ",

    // Section S: version history
    versionHistoryBtn: "Version history",
    versionHistoryTitle: "Version history",
    versionHistoryBackBtn: "← Back",
    versionHistoryEmpty: "No previous versions yet -- this document hasn't been edited since it was published.",
    versionHistoryCurrentLabel: "Current version",
    versionHistoryLoadError: "Could not load version history.",
    versionHistoryRestoreBtn: "Restore this version",
    versionHistoryRestoring: "Restoring…",
    versionHistoryRestoreConfirm: "Restore this version? This publishes it as the new current version -- nothing is lost, the current text is saved as a version too.",
    versionHistoryRestoreErrorPrefix: "Could not restore: ",
    versionHistoryRestoredBanner: "✓ Restored as version {version}.",
    versionHistorySavedAtPrefix: "Replaced",
    versionHistoryVersionLabel: "Version {version}",
    versionHistoryShowDiffBtn: "Show differences",
    versionHistoryHideDiffBtn: "Hide differences",
    versionHistoryDiffVsCurrentLabel: "Compared to the current version",
  },
  el: {
    loading: "Φόρτωση…",
    cancel: "Άκυρο",
    switchMode: "Έξοδος",
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

    // Section Q: pricing tiers -- ίδιο σκεπτικό με το en dict παραπάνω.
    limitReachedMessage: "Αντιμετωπίζουμε προσωρινά τεχνικό πρόβλημα. Επικοινώνησε απευθείας μαζί μας:",
    usageLimitBannerText: "Έφτασες το μηνιαίο όριο μηνυμάτων του πλάνου σου. Οι επισκέπτες βλέπουν προσωρινά ένα γενικό μήνυμα \"τεχνικό πρόβλημα\" αντί για απαντήσεις, μέχρι τον επόμενο μήνα ή μέχρι να αναβαθμίσεις.",
    upgradeBtn: "Αναβάθμιση",
    upgradeTitle: "Αναβάθμιση πλάνου",
    upgradeIntro: "Διάλεξε το πλάνο που ταιριάζει στο workspace σου. Τα νέα όρια ισχύουν μόλις επιβεβαιωθεί η πληρωμή.",
    upgradeCurrentPlan: "Τρέχον πλάνο: {plan}",
    upgradeChoosePlan: "Επιλογή {plan}",
    upgradeMessagesPerMonth: "{n} μηνύματα / μήνα",
    upgradeDocsCount: "{n} έγγραφα",
    upgradeDocsUnlimited: "Απεριόριστα έγγραφα",
    upgradePerMonth: "/ μήνα",
    upgradePerYear: "/ έτος",
    upgradePeriodMonthly: "Μηνιαία",
    upgradePeriodAnnual: "Ετήσια",
    checkoutIntentUnavailable: "Αυτό το πλάνο δεν μπορεί να αγοραστεί από αυτόν τον λογαριασμό αυτή τη στιγμή. Αν έχεις ήδη συνδρομή, χρησιμοποίησε τα κουμπιά επάνω για να τη διαχειριστείς ή να αλλάξεις σε Pro.",
    upgradePoweredBy: "Οι πληρωμές γίνονται με ασφάλεια μέσω Paddle.",
    upgradeLoadError: "Δεν άνοιξε το παράθυρο πληρωμής. Δοκίμασε ξανά σε λίγο.",
    upgradeProcessing: "Η πληρωμή ελήφθη. Το πλάνο σου ενημερώνεται, συνήθως σε λίγα δευτερόλεπτα.",
    upgradeDone: "Έτοιμο. Το πλάνο σου είναι τώρα {plan}.",
    upgradeSlow: "Αργεί περισσότερο από το κανονικό. Η πληρωμή πέρασε, οπότε ανανέωσε τη σελίδα σε ένα λεπτό.",
    planName_free: "Free",
    planName_basic: "Basic",
    planName_pro: "Pro",
    upgradePendingTitle: "Ενεργοποιούμε το πλάνο σου",
    upgradeDoneTitle: "Το πλάνο σου είναι τώρα {plan}",
    upgradeDoneText: "Τα νέα όρια ισχύουν ήδη. Ευχαριστούμε!",
    upgradeBackToDocs: "Πίσω στα έγγραφα",
    upgradePaymentFailed: "Η πληρωμή δεν ολοκληρώθηκε. Μπορείς να δοκιμάσεις ξανά ή με άλλη κάρτα.",
    paymentPendingBanner: "Η πληρωμή σου επεξεργάζεται. Το πλάνο σου θα ενημερωθεί σε λίγο.",
    manageSubBtn: "Διαχείριση συνδρομής",
    changePlanBtn: "Αλλαγή σε Pro",
    changePlanTitle: "Αλλαγή σε Pro",
    changePlanLoading: "Υπολογίζουμε τι θα πληρώσεις...",
    changePlanIntro: "Κρατάς την τρέχουσα συνδρομή σου και πληρώνεις μόνο τη διαφορά για το υπόλοιπο αυτής της περιόδου.",
    changePlanTodayLabel: "Χρέωση σήμερα",
    changePlanTodayNote: "για το υπόλοιπο της τρέχουσας περιόδου, με τον φόρο",
    changePlanRecurringFrom: "Από τις {date}: {amount} / μήνα",
    changePlanRecurringThen: "Στη συνέχεια {amount} / μήνα",
    changePlanRecurringFromYear: "Από τις {date}: {amount} / έτος",
    changePlanRecurringThenYear: "Στη συνέχεια {amount} / έτος",
    changePlanConfirm: "Επιβεβαίωση και πληρωμή {amount}",
    changePlanCancel: "Άκυρο",
    changePlanRetry: "Δοκίμασε ξανά",
    changePlanWorking: "Γίνεται η αλλαγή του πλάνου σου...",
    changePlanErrLockedRenewal: "Η συνδρομή σου ανανεώνεται σε λίγο και δεν μπορεί να αλλάξει αυτή τη στιγμή. Δοκίμασε ξανά σε περίπου μισή ώρα.",
    changePlanErrPendingChanges: "Υπάρχει ήδη μια αλλαγή σε εκκρεμότητα στη συνδρομή σου (π.χ. προγραμματισμένη ακύρωση). Μπορείς να τη δεις από τη Διαχείριση συνδρομής.",
    changePlanErrPastDue: "Η τελευταία πληρωμή δεν πέρασε. Ενημέρωσε πρώτα την κάρτα σου από τη Διαχείριση συνδρομής.",
    changePlanErrFailed: "Η αλλαγή δεν ολοκληρώθηκε και το πλάνο σου δεν άλλαξε. Έλεγξε την κάρτα σου και δοκίμασε ξανά.",
    changePlanErrNotEligible: "Η αλλαγή αυτή δεν είναι διαθέσιμη για τον λογαριασμό σου.",
    changePlanErrUnknown: "Δεν μπορέσαμε να επιβεβαιώσουμε την αλλαγή αυτή τη στιγμή. Ανανέωσε τη σελίδα σε ένα λεπτό για να δεις το τρέχον πλάνο σου, και δοκίμασε ξανά αν δεν άλλαξε.",
    portalError: "Δεν μπόρεσε να ανοίξει η σελίδα χρέωσης. Δοκίμασε ξανά σε λίγο.",

    landingDocTitle: "Idmon — Καλωσόρισες",
    landingIntro: "Επέλεξε πώς θέλεις να συνδεθείς.",
    checkoutIntentNote: "Φτιάξε λογαριασμό (ή συνδέσου) για να συνεχίσεις στο {plan}, {period}. Το παράθυρο πληρωμής ανοίγει αμέσως μετά.",
    checkoutIntentPeriod_monthly: "μηνιαίο",
    checkoutIntentPeriod_annual: "ετήσιο",
    guestTitle: "Επισκέπτης / Guest",
    guestDesc: "Δοκίμασε ελεύθερα το εργαλείο σε έναν δικό σου, ξεχωριστό χώρο. Ό,τι ανεβάσεις δεν το βλέπει κανείς άλλος, και σβήνεται μόνο του μετά από 7 μέρες.",
    accountTitle: "Λογαριασμός",
    accountDesc: "Κάνε εγγραφή ή σύνδεση στον δικό σου μόνιμο χώρο εργασίας, από οποιαδήποτε συσκευή.",
    signupTab: "Εγγραφή",
    loginTab: "Σύνδεση",
    orDivider: "ή",
    emailLabel: "Email",
    passwordLabel: "Κωδικός",
    signupBtn: "Εγγραφή",
    devPasswordLabel: "Κωδικός Developer",
    login: "Είσοδος",
    checking: "Έλεγχος…",
    wrongPassword: "Λάθος κωδικός.",
    connectionErrorPrefix: "Σφάλμα σύνδεσης: ",
    turnstileRequired: "Ολοκλήρωσε την επιβεβαίωση και δοκίμασε ξανά.",
    forgotLink: "Ξέχασες τον κωδικό;",
    sendResetLink: "Στείλε σύνδεσμο επαναφοράς",
    forgotSuccessMessage: "Αν αυτό το email είναι εγγεγραμμένο, στάλθηκε σύνδεσμος επαναφοράς.",
    newPasswordLabel: "Νέος κωδικός",
    confirmPasswordLabel: "Επιβεβαίωση νέου κωδικού",
    confirmPasswordSignupLabel: "Επιβεβαίωση κωδικού",
    setNewPasswordBtn: "Ορισμός νέου κωδικού",
    passwordTooShort: "Ο κωδικός πρέπει να έχει τουλάχιστον 8 χαρακτήρες.",
    passwordsDontMatch: "Οι κωδικοί δεν ταιριάζουν.",
    termsLink: "Όροι Χρήσης",
    privacyLink: "Πολιτική Απορρήτου",
    verifyingEmail: "Επιβεβαίωση του email σου…",
    continueToApp: "Συνέχεια",
    emailVerifiedSuccess: "Το email σου επιβεβαιώθηκε! Μπορείς να συνεχίσεις.",
    verifyBannerText: "Παρακαλούμε επιβεβαίωσε τη διεύθυνση email σου.",
    resendVerificationLink: "Ξαναστείλε email επιβεβαίωσης",
    verificationEmailSent: "Στάλθηκε! Έλεγξε τα εισερχόμενά σου.",
    accountSectionTitle: "Λογαριασμός",
    exportDataBtn: "Εξαγωγή δεδομένων μου",
    deleteAccountBtn: "Διαγραφή λογαριασμού",
    deleteAccountWarning: "Αυτό διαγράφει μόνιμα τον λογαριασμό σου, όλα τα έγγραφα, και τις ρυθμίσεις. Δεν αναιρείται.",
    confirmDeleteAccountBtn: "Μόνιμη διαγραφή",
    deleteAccountPasswordRequired: "Γράψε τον κωδικό σου για επιβεβαίωση.",

    indexDocTitle: "Idmon — Βοηθός",
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

    editorDocTitle: "Διαχείριση Περιεχομένου — Idmon",
    editorHeading: "Διαχείριση Περιεχομένου",
    newDoc: "+ Νέο έγγραφο",
    filterByTitle: "Φίλτρο με τίτλο…",
    documentsLabel: "Έγγραφα",
    allDocs: "Όλα τα έγγραφα",
    searchByDescription: "Βρες με περιγραφή",
    searchExamplePlaceholder: "π.χ. τα ωράρια του Billing…",
    testQuestion: "Δοκιμαστικό ερώτημα",
    testQuestionPlaceholder: "π.χ. Ποιο είναι το όριο έγκρισης;",
    testQGenericErrorMessage: "Κάτι πήγε στραβά. Δοκίμασε ξανά σε λίγο.",
    testQNewConversation: "Νέα συζήτηση",
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
    topQuestionsTitle: "Πιο συχνές ερωτήσεις",
    topQuestionsEmpty: "Δεν υπάρχουν ακόμα αρκετά δεδομένα για συχνές ερωτήσεις.",

    // URL sync (Section M)
    addFromUrlBtn: "🔗 Πρόσθεσε από URL",
    addFromUrlTitle: "🔗 Πρόσθεσε έγγραφο από URL",
    addFromUrlIntro: "Επικόλλησε ένα link σε δημόσια σελίδα (π.χ. τις Συχνές Ερωτήσεις ή τους Όρους σου), και θα τη διαβάσουμε εμείς -- δεν χρειάζεται να κάνεις copy-paste το κείμενο.",
    urlLabel: "URL σελίδας",
    titleOptionalLabel: "Τίτλος (προαιρετικό)",
    titleOptionalPlaceholder: "Άφησέ το κενό για να χρησιμοποιηθεί ο τίτλος της σελίδας",
    addFromUrlSubmitBtn: "Διάβασε τη σελίδα",
    addingFromUrl: "Διαβάζεται…",
    urlRequiredError: "Γράψε πρώτα ένα URL.",
    addFromUrlErrorPrefix: "Δεν προστέθηκε από URL: ",
    uploadFileBtn: "📤 Ανέβασε αρχείο",
    uploadFileTitle: "📤 Ανέβασμα αρχείου",
    uploadFileIntro: "Ανέβασε ένα αρχείο .txt, .md, ή .pdf και θα εξάγουμε εμείς το κείμενο -- δεν χρειάζεται να το κάνεις copy-paste μόνος σου.",
    fileLabel: "Αρχείο",
    uploadFileSubmitBtn: "Ανέβασμα",
    uploadingFile: "Ανεβαίνει…",
    fileRequiredError: "Διάλεξε πρώτα ένα αρχείο.",
    uploadFileErrorPrefix: "Δεν ανέβηκε το αρχείο: ",
    refreshFromUrl: "↻ Ανανέωση από URL",
    refreshingFromUrl: "Ανανεώνεται…",

    // Google Drive connector (Section N)
    googleDriveBtn: "Google Drive",
    googleDriveTitle: "Εισαγωγή από Google Drive",
    googleDriveConnectIntro: "Σύνδεσε τον λογαριασμό Google Drive σου για να εισάγεις Google Docs και Sheets απευθείας, χωρίς copy-paste.",
    googleDriveConnectBtn: "Σύνδεση Google Drive",
    googleDriveConnectedAs: "Συνδεδεμένο ως {email}",
    googleDriveChangeAccountBtn: "Αλλαγή λογαριασμού",
    googleDriveDisconnectBtn: "Αποσύνδεση",
    googleDriveDisconnecting: "Αποσυνδέεται…",
    googleDriveDisconnectErrorPrefix: "Δεν ήταν δυνατή η αποσύνδεση: ",
    googleDriveLoadError: "Δεν ήταν δυνατή η φόρτωση των αρχείων του Google Drive.",
    googleDriveNoFiles: "Δεν βρέθηκαν Google Docs ή Sheets στο Drive σου.",
    googleDriveModifiedPrefix: "Τροποποιήθηκε",
    googleDriveImportBtn: "Εισαγωγή επιλεγμένων ({count})",
    googleDriveImporting: "Γίνεται εισαγωγή…",
    googleDriveImportErrorPrefix: "Η εισαγωγή απέτυχε: ",
    googleDriveImportSummary: "Εισήχθησαν {success} από {total} αρχεία ως πρόχειρα.",
    googleDriveImportFailedPrefix: "Δεν ήταν δυνατή η εισαγωγή: ",
    googleDriveConnectedBanner: "✓ Το Google Drive συνδέθηκε επιτυχώς.",
    googleDriveErrorDenied: "Η σύνδεση με τη Google ακυρώθηκε.",
    googleDriveErrorMissingParams: "Κάτι πήγε στραβά κατά τη σύνδεση. Δοκίμασε ξανά.",
    googleDriveErrorInvalidState: "Αυτός ο σύνδεσμος σύνδεσης έληξε. Δοκίμασε να συνδεθείς ξανά.",
    googleDriveErrorTokenExchangeFailed: "Η σύνδεση με τη Google απέτυχε. Δοκίμασε ξανά.",
    googleDriveErrorNoRefreshToken: "Δοκίμασε να συνδεθείς ξανά και ενέκρινε πλήρη πρόσβαση όταν σου ζητηθεί.",
    googleDriveErrorMissingScope: "Δεν εγκρίθηκε η πρόσβαση στο Google Drive. Δοκίμασε να συνδεθείς ξανά και βεβαιώσου ότι το checkbox του Google Drive είναι τσεκαρισμένο πριν συνεχίσεις.",
    googleDriveErrorGeneric: "Κάτι πήγε στραβά κατά τη σύνδεση με το Google Drive.",
    refreshFromUrlErrorPrefix: "Σφάλμα ανανέωσης: ",

    // Section S: ιστορικότητα εκδόσεων
    versionHistoryBtn: "Ιστορικό εκδόσεων",
    versionHistoryTitle: "Ιστορικό εκδόσεων",
    versionHistoryBackBtn: "← Πίσω",
    versionHistoryEmpty: "Δεν υπάρχουν ακόμα προηγούμενες εκδόσεις -- το έγγραφο δεν έχει επεξεργαστεί από τότε που δημοσιεύτηκε.",
    versionHistoryCurrentLabel: "Τρέχουσα έκδοση",
    versionHistoryLoadError: "Δεν ήταν δυνατή η φόρτωση του ιστορικού εκδόσεων.",
    versionHistoryRestoreBtn: "Επαναφορά αυτής της έκδοσης",
    versionHistoryRestoring: "Γίνεται επαναφορά…",
    versionHistoryRestoreConfirm: "Επαναφορά αυτής της έκδοσης; Θα δημοσιευτεί σαν νέα τρέχουσα έκδοση -- τίποτα δεν χάνεται, το τρέχον κείμενο αποθηκεύεται κι αυτό σαν έκδοση.",
    versionHistoryRestoreErrorPrefix: "Δεν ήταν δυνατή η επαναφορά: ",
    versionHistoryRestoredBanner: "✓ Έγινε επαναφορά ως έκδοση {version}.",
    versionHistorySavedAtPrefix: "Αντικαταστάθηκε",
    versionHistoryVersionLabel: "Έκδοση {version}",
    versionHistoryShowDiffBtn: "Εμφάνιση διαφορών",
    versionHistoryHideDiffBtn: "Απόκρυψη διαφορών",
    versionHistoryDiffVsCurrentLabel: "Σε σύγκριση με την τρέχουσα έκδοση",
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