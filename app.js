const STORAGE_KEY = "quiet-desk-entries-v1";
const DB_NAME = "zhi-qiu-storage";
const DB_VERSION = 1;
const DB_STORE = "workspace";

const sectionMeta = {
  journal: { label: "JOURNAL", title: "日记", modal: "写一篇日记", placeholder: "写下今天的心情、观察或片段……" },
  memo: { label: "MEMO", title: "备忘", modal: "记一件待办", placeholder: "记录一个想法、提醒或待办……" },
  quote: { label: "EXCERPT", title: "摘录", modal: "收藏一段摘录", placeholder: "粘贴或写下让你停留的一句话……" },
  focus: { label: "FOCUS", title: "专注", modal: "", placeholder: "" }
};

const moods = [
  { id: "sunny", label: "明亮", color: "#d3b47b", asset: "sheet2-0-0.png" },
  { id: "calm", label: "平静", color: "#8eaa91", asset: "sheet2-1-0.png" },
  { id: "tender", label: "柔软", color: "#c79791", asset: "sheet3-0-0.png" },
  { id: "tired", label: "疲惫", color: "#9f9bb0", asset: "sheet3-1-0.png" },
  { id: "cloudy", label: "低落", color: "#aab1b5", asset: "sheet1-0-2.png" }
];

const seedEntries = [
  { id: crypto.randomUUID(), section: "journal", journalType: "standard", title: "星期一，雨停以后", body: "窗台的水珠慢慢散开，空气里有一点潮湿的松木味。今天没有急着赶路。", author: "", mood: "calm", createdAt: "2026-08-17T08:30:00" },
  { id: crypto.randomUUID(), section: "memo", title: "给下周的自己", body: "周三下午留一小时，整理书桌左侧的资料。", author: "", createdAt: "2026-08-16T12:10:00" },
  { id: crypto.randomUUID(), section: "quote", title: "关于慢", body: "“慢慢来，比较快。”", author: "林清玄", createdAt: "2026-08-14T19:45:00" }
];

let entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || seedEntries;
let activeSection = "journal";
let activeJournalType = "standard";
let activeQuoteType = "copy";
let selectedMoodId = "calm";
let deferredInstallPrompt = null;
let editingId = null;
let bookPages = [];
let bookPageIndex = 0;
let focusMinutes = 25;
let focusRemaining = 25 * 60;
let focusTimerId = null;
let focusTimerRunning = false;
let focusEndAt = 0;
let focusSessions = Number(localStorage.getItem("quiet-desk-focus-sessions") || 0);
let quoteImageData = "";
let tesseractLoadPromise = null;
let tesseractAssetBase = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist";

const $ = (selector) => document.querySelector(selector);
const entryList = $("#entryList");
const emptyState = $("#emptyState");
const searchInput = $("#searchInput");
const modal = $("#entryModal");
const backdrop = $("#modalBackdrop");
const bookModal = $("#bookModal");
const contentArea = $("#contentArea");
const focusPanel = $("#focusPanel");

function openStorageDb() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return resolve(null);
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function readStoredEntries() {
  try {
    const db = await openStorageDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get("entries");
      request.onsuccess = () => resolve(Array.isArray(request.result) ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  } catch { return null; }
}
async function writeStoredEntries() {
  try {
    const db = await openStorageDb();
    if (!db) return;
    await new Promise((resolve, reject) => {
      const request = db.transaction(DB_STORE, "readwrite").objectStore(DB_STORE).put(entries, "entries");
      request.onsuccess = resolve; request.onerror = () => reject(request.error);
    });
  } catch { /* localStorage remains as fallback */ }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  writeStoredEntries();
}
async function restorePersistentData() {
  try {
    if (navigator.storage?.persist) await navigator.storage.persist();
    const stored = await readStoredEntries();
    if (stored?.length) {
      entries = stored;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      render();
    } else {
      await writeStoredEntries();
    }
  } catch { /* keep the already loaded localStorage data */ }
}
function todayISO() { return new Date().toISOString().slice(0, 10); }
function monthISO(value = todayISO()) { return String(value).slice(0, 7); }
function formatDate(value) {
  const safeValue = /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? `${value}T00:00:00` : value;
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(safeValue));
}
function formatToday() { return new Intl.DateTimeFormat("zh-CN", { weekday: "long", month: "long", day: "numeric" }).format(new Date()); }
function formatMonth(month) {
  const [year, monthNumber] = month.split("-");
  return `${year} 年 ${Number(monthNumber)} 月`;
}
function entryDateISO(entry) { return entry.entryDate || String(entry.createdAt || todayISO()).slice(0, 10); }
function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
function normalizedJournalType(entry) { return entry.journalType || "standard"; }
function normalizedQuoteType(entry) { return entry.quoteType || "copy"; }
function moodFor(id) { return moods.find((mood) => mood.id === id) || moods[1]; }
function moodIcon(id, size = 28) {
  const mood = moodFor(id);
  return `<img class="cat-image" src="moods/${mood.asset}" alt="${mood.label}" style="--cat-color:${mood.color};--sprite-size:${size}px" />`;
}
function moodChip(id) { const mood = moodFor(id); return `<span class="mood-chip">${moodIcon(id, 24)}<span>${mood.label}</span></span>`; }
function renderMoodPicker() {
  $("#moodGrid").innerHTML = moods.map((mood) => `<button type="button" class="mood-option ${mood.id === selectedMoodId ? "is-selected" : ""}" data-mood="${mood.id}" role="radio" aria-checked="${mood.id === selectedMoodId}">${moodIcon(mood.id, 42)}<span>${mood.label}</span></button>`).join("");
}
function partsText(entry) { return entry.parts ? ["three", "two", "one"].flatMap((key) => entry.parts[key] || []).join(" ") : ""; }
function searchText(entry) { return `${entry.title || ""} ${entry.body || ""} ${entry.author || ""} ${partsText(entry)}`.toLowerCase(); }
function visibleEntries() {
  const query = searchInput.value.trim().toLowerCase();
  return entries.filter((entry) => entry.section === activeSection && (activeSection !== "journal" || normalizedJournalType(entry) === activeJournalType) && (activeSection !== "quote" || normalizedQuoteType(entry) === activeQuoteType) && searchText(entry).includes(query));
}
function render321Parts(entry) {
  const parts = entry.parts || { three: [], two: [], one: [] };
  const group = (number, label, key) => {
    const values = (parts[key] || []).filter(Boolean);
    if (!values.length) return "";
    return `<div class="entry-format-group"><span class="entry-format-number">${number}</span><div><small>${label}</small>${values.map((value) => `<p>${escapeHtml(value)}</p>`).join("")}</div></div>`;
  };
  return `<div class="entry-321">${group(3, "感恩的三件事", "three")}${group(2, "让今天变好的两件事 / 感悟", "two")}${group(1, "自我肯定", "one")}</div>`;
}
function render() {
  const list = visibleEntries();
  const meta = sectionMeta[activeSection];
  $("#sectionKicker").textContent = meta.label;
  $("#sectionTitle").textContent = meta.title;
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.section === activeSection));
  $("#journalModeTabs").hidden = activeSection !== "journal";
  $("#quoteModeTabs").hidden = activeSection !== "quote";
  $("#monthlyBookButton").hidden = activeSection !== "journal";
  const utilitySection = activeSection === "focus";
  contentArea.hidden = utilitySection;
  focusPanel.hidden = activeSection !== "focus";
  document.querySelectorAll(".journal-mode").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.journalType === activeJournalType));
  document.querySelectorAll(".quote-mode").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.quoteType === activeQuoteType));
  Object.keys(sectionMeta).forEach((key) => { $(`#count-${key}`).textContent = entries.filter((entry) => entry.section === key).length; });
  $("#count-focus").textContent = focusSessions;
  $("#count-journal-standard").textContent = entries.filter((entry) => entry.section === "journal" && normalizedJournalType(entry) === "standard").length;
  $("#count-journal-321").textContent = entries.filter((entry) => entry.section === "journal" && normalizedJournalType(entry) === "321").length;
  $("#count-quote-copy").textContent = entries.filter((entry) => entry.section === "quote" && normalizedQuoteType(entry) === "copy").length;
  $("#count-quote-fact").textContent = entries.filter((entry) => entry.section === "quote" && normalizedQuoteType(entry) === "fact").length;
  entryList.innerHTML = list.map((entry, index) => `
    <article class="entry-card" data-section="${entry.section}" data-journal-type="${normalizedJournalType(entry)}" data-quote-type="${normalizedQuoteType(entry)}" style="animation-delay:${index * 40}ms">
      <div class="entry-meta"><span>${formatDate(entryDateISO(entry))}</span><span class="card-actions"><button class="card-action" data-edit="${entry.id}">编辑</button><button class="card-action delete-entry" data-delete="${entry.id}" aria-label="删除这条记录">×</button></span></div>
      ${entry.section !== "quote" && entry.title ? `<h3 class="entry-title">${escapeHtml(entry.title)}</h3>` : ""}
      ${entry.section === "journal" && entry.mood ? moodChip(entry.mood) : ""}
      ${normalizedJournalType(entry) === "321" ? render321Parts(entry) : `<p class="entry-body">${escapeHtml(entry.body)}</p>`}
      ${entry.section === "quote" && entry.imageData ? `<img class="quote-thumb" src="${entry.imageData}" alt="摘录图片" />` : ""}
      ${entry.section !== "quote" && entry.author ? `<p class="entry-author">— ${escapeHtml(entry.author)}</p>` : ""}
    </article>`).join("");
  emptyState.hidden = list.length > 0;
  entryList.hidden = list.length === 0;
}

function applyFormMode(entry = null) {
  const isJournal = activeSection === "journal";
  const is321 = isJournal && activeJournalType === "321";
  $("#standardFields").hidden = is321;
  $("#threeTwoOneFields").hidden = !is321;
  $("#quoteFields").hidden = activeSection !== "quote";
  $("#titleField").hidden = is321 || activeSection === "quote";
  $("#quoteSourceField").hidden = activeSection === "quote";
  $("#journalDateField").hidden = !is321;
  $("#moodField").hidden = !isJournal;
  $("#entryBody").required = !is321;
  $("#entryDate").required = is321;
  $("#titleLabel").innerHTML = "标题 <span>可选</span>";
  $("#bodyLabel").textContent = activeSection === "quote" ? "摘录内容" : "内容";
  $("#entryTitle").required = false;
  $("#entryTitle").placeholder = "给这段记录一个名字";
  $("#entryDate").value = entry?.entryDate || todayISO();
  quoteImageData = entry?.imageData || "";
  $("#quoteImagePreview").src = quoteImageData;
  $("#quoteImagePreview").hidden = !quoteImageData;
  $("#ocrButton").disabled = !quoteImageData;
  $("#ocrStatus").hidden = true;
  $("#ocrRetryButton").hidden = true;
  renderMoodPicker();
  if (entry) {
    $("#entryTitle").value = entry.title || "";
    $("#entryBody").value = entry.body || "";
    $("#entryAuthor").value = entry.author || "";
    selectedMoodId = entry.mood || "calm";
    renderMoodPicker();
    const parts = entry.parts || { three: [], two: [], one: [] };
    ["gratitudeA", "gratitudeB", "gratitudeC"].forEach((name, index) => { $(`[name="${name}"]`).value = parts.three?.[index] || ""; });
    ["betterA", "betterB"].forEach((name, index) => { $(`[name="${name}"]`).value = parts.two?.[index] || ""; });
    $("[name=affirmation]").value = parts.one?.[0] || "";
  }
}
function openModal(entry = null) {
  if (entry) { activeSection = entry.section; activeJournalType = normalizedJournalType(entry); activeQuoteType = normalizedQuoteType(entry); }
  const meta = sectionMeta[activeSection];
  editingId = entry?.id || null;
  selectedMoodId = entry?.mood || "calm";
  $("#modalKicker").textContent = activeSection === "journal" && activeJournalType === "321" ? "321 JOURNAL" : activeSection === "quote" ? (activeQuoteType === "fact" ? "FACTS" : "COPY") : meta.label;
  $("#modalTitle").textContent = entry ? "编辑这条记录" : (activeSection === "journal" && activeJournalType === "321" ? "写一篇 321 日记" : activeSection === "quote" ? (activeQuoteType === "fact" ? "收藏一条干货" : "收藏一段文案") : meta.modal);
  $("#entryBody").placeholder = meta.placeholder;
  $("#entryForm").reset();
  applyFormMode(entry);
  modal.hidden = false; backdrop.hidden = false;
  setTimeout(() => $("#entryTitle").focus(), 50);
}
function closeModal() { modal.hidden = true; backdrop.hidden = true; editingId = null; }

function monthlyEntries(month) { return entries.filter((entry) => entry.section === "journal" && entryDateISO(entry).startsWith(month)).sort((a, b) => entryDateISO(a).localeCompare(entryDateISO(b))); }
function notebookPages(month) {
  const list = monthlyEntries(month);
  const pages = [`<article class="book-page book-cover"><div class="book-cover-mark">知秋</div><p class="section-kicker">MONTHLY JOURNAL</p><h3>${formatMonth(month)}</h3><p>${list.length ? `收录 ${list.length} 篇日记` : "给这个月留一页空白"}</p></article>`];
  list.forEach((entry) => pages.push(`<article class="book-page diary-page"><div class="book-page-date">${formatDate(entryDateISO(entry))}${entry.mood ? moodChip(entry.mood) : ""}</div>${entry.section !== "quote" && entry.title ? `<h3>${escapeHtml(entry.title)}</h3>` : ""}${normalizedJournalType(entry) === "321" ? render321Parts(entry) : `<p class="book-body">${escapeHtml(entry.body)}</p>`}</article>`));
  pages.push(`<article class="book-page book-back"><p>这个月的每一次记录，<br />都值得被温柔保存。</p><span>知秋</span></article>`);
  return pages;
}
function renderBook() {
  const month = $("#bookMonth").value || monthISO();
  bookPages = notebookPages(month);
  bookPageIndex = Math.min(bookPageIndex, bookPages.length - 1);
  $("#bookViewer").innerHTML = bookPages[bookPageIndex];
  $("#bookPageCount").textContent = `${bookPageIndex + 1} / ${bookPages.length}`;
  $("#bookPrev").disabled = bookPageIndex === 0;
  $("#bookNext").disabled = bookPageIndex === bookPages.length - 1;
  $("#bookPrintArea").innerHTML = bookPages.join("");
}
function openBook() { $("#bookMonth").value = monthISO(); bookPageIndex = 0; renderBook(); bookModal.hidden = false; backdrop.hidden = false; }
function closeBook() { bookModal.hidden = true; backdrop.hidden = true; }

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => { activeSection = tab.dataset.section; searchInput.value = ""; render(); }));
document.querySelectorAll(".journal-mode").forEach((tab) => tab.addEventListener("click", () => { activeJournalType = tab.dataset.journalType; searchInput.value = ""; render(); }));
document.querySelectorAll(".quote-mode").forEach((tab) => tab.addEventListener("click", () => { activeQuoteType = tab.dataset.quoteType; searchInput.value = ""; render(); }));
$("#moodGrid").addEventListener("click", (event) => { const button = event.target.closest("[data-mood]"); if (!button) return; selectedMoodId = button.dataset.mood; renderMoodPicker(); });
$("#newEntryButton").addEventListener("click", () => openModal());
$("#emptyCreateButton").addEventListener("click", () => openModal());
$("#closeModal").addEventListener("click", closeModal);
$("#cancelModal").addEventListener("click", closeModal);
backdrop.addEventListener("click", () => { closeModal(); closeBook(); });
searchInput.addEventListener("input", render);
$("#clearSearch").addEventListener("click", () => { searchInput.value = ""; searchInput.focus(); render(); });
entryList.addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit]");
  if (editButton) { const entry = entries.find((item) => item.id === editButton.dataset.edit); if (entry) openModal(entry); return; }
  const deleteButton = event.target.closest("[data-delete]");
  if (!deleteButton) return;
  entries = entries.filter((entry) => entry.id !== deleteButton.dataset.delete); save(); render();
});

$("#entryForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const is321 = activeSection === "journal" && activeJournalType === "321";
  const title = String(form.get("title") || "").trim();
  const author = String(form.get("author") || "").trim();
  const parts = is321 ? { three: ["gratitudeA", "gratitudeB", "gratitudeC"].map((name) => String(form.get(name) || "").trim()), two: ["betterA", "betterB"].map((name) => String(form.get(name) || "").trim()), one: [String(form.get("affirmation") || "").trim()] } : null;
  const body = is321 ? parts.three.concat(parts.two, parts.one).join(" ").trim() : String(form.get("body") || "").trim();
  if (!body) return;
  if (is321 && parts.three.concat(parts.two, parts.one).some((value) => !value)) { alert("请完成 3-2-1 日记的全部内容。"); return; }
  const data = { section: activeSection, journalType: activeSection === "journal" ? activeJournalType : undefined, quoteType: activeSection === "quote" ? activeQuoteType : undefined, title: is321 || activeSection === "quote" ? "" : title, body, parts, author: activeSection === "quote" ? "" : author, mood: activeSection === "journal" ? selectedMoodId : undefined, imageData: activeSection === "quote" ? quoteImageData : undefined, entryDate: is321 ? String(form.get("entryDate") || todayISO()) : undefined };
  if (editingId) entries = entries.map((entry) => entry.id === editingId ? { ...entry, ...data, updatedAt: new Date().toISOString() } : entry);
  else entries.unshift({ id: crypto.randomUUID(), ...data, createdAt: new Date().toISOString() });
  save(); closeModal(); render();
});

$("#monthlyBookButton").addEventListener("click", openBook);
$("#closeBook").addEventListener("click", closeBook);
$("#bookMonth").addEventListener("change", () => { bookPageIndex = 0; renderBook(); });
$("#bookPrev").addEventListener("click", () => { if (bookPageIndex > 0) { bookPageIndex -= 1; renderBook(); } });
$("#bookNext").addEventListener("click", () => { if (bookPageIndex < bookPages.length - 1) { bookPageIndex += 1; renderBook(); } });
$("#bookPrint").addEventListener("click", () => { renderBook(); window.print(); });

function renderFocusTimer() {
  const minutes = String(Math.floor(focusRemaining / 60)).padStart(2, "0");
  const seconds = String(focusRemaining % 60).padStart(2, "0");
  $("#focusTime").textContent = `${minutes}:${seconds}`;
  $("#focusLabel").textContent = focusTimerRunning ? "正在专注" : (focusRemaining === focusMinutes * 60 ? "准备开始" : "已暂停");
  $("#focusStart").textContent = focusTimerRunning ? "暂停专注" : "开始专注";
}
function stopFocusTimer() {
  if (focusTimerId !== null) window.clearInterval(focusTimerId);
  focusTimerId = null;
  focusTimerRunning = false;
  focusEndAt = 0;
}
function tickFocusTimer() {
  if (!focusTimerRunning) return;
  focusRemaining = Math.max(0, Math.ceil((focusEndAt - Date.now()) / 1000));
  if (focusRemaining <= 0) {
    stopFocusTimer();
    focusSessions += 1;
    localStorage.setItem("quiet-desk-focus-sessions", String(focusSessions));
    renderFocusTimer();
    render();
    alert("专注完成，辛苦了。");
    return;
  }
  renderFocusTimer();
}
function setFocusMinutes(minutes) { if (focusTimerRunning) return; focusMinutes = minutes; focusRemaining = minutes * 60; renderFocusTimer(); }
function toggleFocus() {
  if (focusTimerRunning) { focusRemaining = Math.max(0, Math.ceil((focusEndAt - Date.now()) / 1000)); stopFocusTimer(); renderFocusTimer(); return; }
  focusTimerRunning = true;
  focusEndAt = Date.now() + focusRemaining * 1000;
  focusTimerId = window.setInterval(tickFocusTimer, 250);
  tickFocusTimer();
}
$(".focus-preset").forEach((button) => button.addEventListener("click", () => { $(".focus-preset").forEach((item) => item.classList.remove("is-active")); button.classList.add("is-active"); setFocusMinutes(Number(button.dataset.minutes)); }));
let lastFocusPointerAt = 0;
function handleFocusStart(event) { if (event.type === "pointerup") { lastFocusPointerAt = Date.now(); toggleFocus(); return; } if (Date.now() - lastFocusPointerAt < 500) return; toggleFocus(); }
$("#focusStart").addEventListener("pointerup", handleFocusStart);
$("#focusStart").addEventListener("click", handleFocusStart);
$("#focusReset").addEventListener("click", () => { stopFocusTimer(); focusRemaining = focusMinutes * 60; renderFocusTimer(); });
document.addEventListener("visibilitychange", () => { if (!document.hidden) tickFocusTimer(); });

function setOcrStatus(message, { error = false } = {}) {
  const status = $("#ocrStatus");
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle("is-error", error);
}

function loadTesseractScript(url, assetBase) {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => { if (!window.Tesseract) return reject(new Error("engine-unavailable")); tesseractAssetBase = assetBase; resolve(window.Tesseract); };
    script.onerror = () => reject(new Error("script-load-failed"));
    document.head.appendChild(script);
  });
}

async function ensureTesseract() {
  if (window.Tesseract) return window.Tesseract;
  if (!tesseractLoadPromise) {
    tesseractLoadPromise = loadTesseractScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js", "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist")
      .catch(() => loadTesseractScript("https://unpkg.com/tesseract.js@5/dist/tesseract.min.js", "https://unpkg.com/tesseract.js@5/dist"));
  }
  const engine = await tesseractLoadPromise;
  if (!engine) throw new Error("engine-unavailable");
  return engine;
}

$("#quoteImage").addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  quoteImageData = await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.readAsDataURL(file); });
  $("#quoteImagePreview").src = quoteImageData; $("#quoteImagePreview").hidden = false; $("#ocrButton").disabled = false; $("#ocrRetryButton").hidden = true;
  setOcrStatus("图片已上传，点击“识别图片文字”开始识别。", {});
});
$("#ocrButton").addEventListener("click", async () => {
  if (!quoteImageData) return;
  const status = $("#ocrStatus"); const button = $("#ocrButton");
  button.disabled = true; $("#ocrRetryButton").hidden = true;
  setOcrStatus("正在加载识别引擎和中文识别包，请稍候……");
  try {
    const engine = await ensureTesseract();
    const workerOptions = {
      workerPath: `${tesseractAssetBase}/worker.min.js`,
      corePath: tesseractAssetBase.includes("unpkg.com") ? "https://unpkg.com/tesseract.js-core@5/tesseract-core.wasm.js" : "https://cdn.jsdelivr.net/npm/tesseract.js-core@5/tesseract-core.wasm.js",
      logger: (message) => {
        if (message.status === "loading language traineddata") setOcrStatus("正在加载中文识别包……");
        else if (message.status === "recognizing text" && message.progress) setOcrStatus(`正在识别图片文字 ${Math.round(message.progress * 100)}%`);
      }
    };
    let result;
    let lastError;
    for (const langPath of ["https://tessdata.projectnaptha.com/4.0.0", "https://cdn.jsdelivr.net/gh/tesseract-ocr/tessdata_fast@main"]) {
      try {
        result = await engine.recognize(quoteImageData, "chi_sim+eng", { ...workerOptions, langPath });
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!result) throw lastError || new Error("ocr-failed");
    const text = result?.data?.text?.trim() || "";
    $("#entryBody").value = text;
    setOcrStatus(text ? "识别完成，文字已填入内容框。" : "没有识别到清晰文字，可以手动输入。", { error: !text });
  } catch (error) {
    console.error("OCR failed", error);
    setOcrStatus("识别引擎加载失败。请保持网络畅通后点击“重新加载识别”。", { error: true });
    $("#ocrRetryButton").hidden = false;
  }
  button.disabled = false;
});
$("#ocrRetryButton").addEventListener("click", () => {
  tesseractLoadPromise = null;
  $("#ocrButton").click();
});

$("#exportButton").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `知秋备份-${todayISO()}.json`; link.click(); URL.revokeObjectURL(url);
});
$("#importInput").addEventListener("change", async (event) => {
  const file = event.target.files?.[0]; if (!file) return;
  try { const parsed = JSON.parse(await file.text()); if (!Array.isArray(parsed.entries) || parsed.entries.some((entry) => !entry.body || !sectionMeta[entry.section])) throw new Error("invalid"); entries = parsed.entries; save(); render(); alert("备份已恢复。"); }
  catch { alert("无法读取这个备份文件，请选择知秋导出的 JSON 文件。"); }
  finally { event.target.value = ""; }
});

$("#todayLabel").textContent = formatToday();
renderFocusTimer();
render();
restorePersistentData();
window.addEventListener("pagehide", () => { save(); });
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") save(); });
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); deferredInstallPrompt = event; $("#installButton").hidden = false; });
$("#installButton").addEventListener("click", async () => { if (!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice; deferredInstallPrompt = null; $("#installButton").hidden = true; });
window.addEventListener("appinstalled", () => { $("#installButton").hidden = true; });
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js?v=18"));
