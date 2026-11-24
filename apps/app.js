// ============================================================================
// CONFIGURATION — Replace with your Google Cloud OAuth 2.0 Client ID
// ============================================================================
const CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";

// Storage Keys (Only stores folder ID and today's shown file IDs)
const STORAGE_KEYS = {
  FOLDER_ID: "dm_shared_folder_id",
  DAILY_STATE: "dm_daily_state_v1"
};

// App State
let tokenClient = null;
let accessToken = null;
let allFolderPhotos = []; // Array of { id, name, createdTime, imageMediaMetadata }
let activeBlobUrls = [];  // Track blob URLs to revoke memory cleanly

// DOM Elements
const views = {
  auth: document.getElementById("auth-view"),
  setup: document.getElementById("setup-view"),
  memories: document.getElementById("memories-view")
};

const els = {
  dateSubtitle: document.getElementById("date-subtitle"),
  signinBtn: document.getElementById("signin-btn"),
  signoutBtn: document.getElementById("signout-btn"),
  folderInput: document.getElementById("folder-input"),
  saveFolderBtn: document.getElementById("save-folder-btn"),
  setupError: document.getElementById("setup-error"),
  changeFolderBtn: document.getElementById("change-folder-btn"),
  poolStatus: document.getElementById("pool-status"),
  loader: document.getElementById("loader"),
  errorBanner: document.getElementById("error-banner"),
  errorMessage: document.getElementById("error-message"),
  retryBtn: document.getElementById("retry-btn"),
  photosFeed: document.getElementById("photos-feed"),
  controlsBar: document.getElementById("controls-bar"),
  anotherBtn: document.getElementById("another-btn"),
  remainingCount: document.getElementById("remaining-count"),
  lightbox: document.getElementById("lightbox"),
  lightboxImg: document.getElementById("lightbox-img"),
  lightboxCaption: document.getElementById("lightbox-caption"),
  lightboxClose: document.getElementById("lightbox-close")
};

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  // Display today's formatted date
  const now = new Date();
  els.dateSubtitle.textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

  // Wait for Google Identity Services script to load
  const waitForGIS = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      clearInterval(waitForGIS);
      initGoogleAuth();
    }
  }, 100);

  bindEvents();
});

function initGoogleAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: (tokenResponse) => {
      if (tokenResponse.error) {
        showError("Sign-in failed: " + tokenResponse.error);
        return;
      }
      accessToken = tokenResponse.access_token;
      els.signoutBtn.classList.remove("hidden");
      onAuthenticated();
    }
  });
}

function bindEvents() {
  els.signinBtn.addEventListener("click", () => {
    if (!tokenClient) return;
    tokenClient.requestAccessToken({ prompt: "consent" });
  });

  els.signoutBtn.addEventListener("click", () => {
    if (accessToken) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    allFolderPhotos = [];
    clearFeed();
    els.signoutBtn.classList.add("hidden");
    switchView("auth");
  });

  els.saveFolderBtn.addEventListener("click", handleSaveFolder);
  els.changeFolderBtn.addEventListener("click", () => {
    els.folderInput.value = localStorage.getItem(STORAGE_KEYS.FOLDER_ID) || "";
    switchView("setup");
  });

  els.retryBtn.addEventListener("click", () => loadDailyMemories());
  els.anotherBtn.addEventListener("click", handleShowAnotherMemory);

  // Lightbox events
  els.lightboxClose.addEventListener("click", closeLightbox);
  els.lightbox.addEventListener("click", (e) => {
    if (e.target === els.lightbox) closeLightbox();
  });
}

function switchView(viewName) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[viewName].classList.add("active");
}

// ============================================================================
// FOLDER SETUP & VALIDATION
// ============================================================================
function extractFolderId(input) {
  const trimmed = input.trim();
  // Match URLs like https://drive.google.com/drive/folders/1a2B3c4D5e...
  const urlMatch = trimmed.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (urlMatch && urlMatch[1]) return urlMatch[1];

  // Match raw IDs
  const idMatch = trimmed.match(/^[a-zA-Z0-9_-]{15,}$/);
  if (idMatch) return trimmed;

  return null;
}

function handleSaveFolder() {
  const folderId = extractFolderId(els.folderInput.value);
  if (!folderId) {
    els.setupError.textContent = "Please enter a valid Google Drive folder link or ID.";
    els.setupError.classList.remove("hidden");
    return;
  }

  els.setupError.classList.add("hidden");
  const previousFolderId = localStorage.getItem(STORAGE_KEYS.FOLDER_ID);
  localStorage.setItem(STORAGE_KEYS.FOLDER_ID, folderId);

  // Reset daily tracking if user switched to a different folder
  if (previousFolderId !== folderId) {
    localStorage.removeItem(STORAGE_KEYS.DAILY_STATE);
  }

  loadDailyMemories();
}

function onAuthenticated() {
  const savedFolderId = localStorage.getItem(STORAGE_KEYS.FOLDER_ID);
  if (!savedFolderId) {
    switchView("setup");
  } else {
    loadDailyMemories();
  }
}

// ============================================================================
// GOOGLE DRIVE API FETCHING
// ============================================================================
async function driveFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    // Token expired; prompt refresh silently or interactively
    throw new Error("SESSION_EXPIRED");
  }
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Drive API Error (${res.status})`);
  }
  return res;
}

/**
 * Recursively collects all image files inside the shared folder and any subfolders.
 */
async function fetchAllPhotosInFolder(rootFolderId) {
  const photos = [];
  const foldersToScan = [rootFolderId];
  const scannedFolders = new Set();

  while (foldersToScan.length > 0) {
    const currentFolderId = foldersToScan.shift();
    if (scannedFolders.has(currentFolderId)) continue;
    scannedFolders.add(currentFolderId);

    let pageToken = null;
    do {
      const q = encodeURIComponent(
        `'${currentFolderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType = 'application/vnd.google-apps.folder')`
      );
      const fields = encodeURIComponent(
        "nextPageToken, files(id, name, mimeType, createdTime, imageMediaMetadata(time))"
      );
      let url = `https://www.googleapis.com/drive/v3/files?q=${q}&fields=${fields}&pageSize=1000&includeItemsFromAllDrives=true&supportsAllDrives=true`;
      if (pageToken) url += `&pageToken=${pageToken}`;

      const res = await driveFetch(url);
      const data = await res.json();

      for (const file of data.files || []) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          foldersToScan.push(file.id);
        } else if (file.mimeType.startsWith("image/")) {
          photos.push(file);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return photos;
}

// ============================================================================
// DAILY SELECTION & DEDUPLICATION LOGIC
// ============================================================================
function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function getDailyState() {
  const today = getTodayKey();
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.DAILY_STATE);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.date === today && Array.isArray(parsed.shownIds)) {
        return parsed;
      }
    }
  } catch (e) {
    // Ignore storage parse errors
  }
  return { date: today, shownIds: [], todaysBatchIds: [] };
}

function saveDailyState(state) {
  localStorage.setItem(STORAGE_KEYS.DAILY_STATE, JSON.stringify(state));
}

function pickRandomItems(array, count) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// ============================================================================
// RENDERING MEMORIES
// ============================================================================
async function loadDailyMemories() {
  switchView("memories");
  clearFeed();
  els.errorBanner.classList.add("hidden");
  els.controlsBar.classList.add("hidden");
  els.loader.classList.remove("hidden");

  const folderId = localStorage.getItem(STORAGE_KEYS.FOLDER_ID);

  try {
    allFolderPhotos = await fetchAllPhotosInFolder(folderId);

    if (allFolderPhotos.length === 0) {
      throw new Error("No images were found in this folder. Make sure the folder is shared with your Google account.");
    }

    els.poolStatus.textContent = `${allFolderPhotos.length} photos in shared folder`;

    const state = getDailyState();
    const photoMap = new Map(allFolderPhotos.map((p) => [p.id, p]));

    // Check if we already picked today's 5 photos earlier today
    let photosToDisplay = state.todaysBatchIds
      .map((id) => photoMap.get(id))
      .filter(Boolean);

    // If it's a new day (or first visit today), pick 5 random photos
    if (photosToDisplay.length === 0) {
      const unseen = allFolderPhotos.filter((p) => !state.shownIds.includes(p.id));
      const pool = unseen.length > 0 ? unseen : allFolderPhotos;
      photosToDisplay = pickRandomItems(pool, 5);

      state.todaysBatchIds = photosToDisplay.map((p) => p.id);
      state.shownIds = Array.from(new Set([...state.shownIds, ...state.todaysBatchIds]));
      saveDailyState(state);
    }

    els.loader.classList.add("hidden");

    for (const photo of photosToDisplay) {
      await appendPhotoCard(photo);
    }

    updateControlsUI();
    els.controlsBar.classList.remove("hidden");
  } catch (err) {
    els.loader.classList.add("hidden");
    if (err.message === "SESSION_EXPIRED") {
      tokenClient.requestAccessToken({ prompt: "" });
    } else {
      showError(err.message);
    }
  }
}

async function handleShowAnotherMemory() {
  const state = getDailyState();
  const unseenPhotos = allFolderPhotos.filter((p) => !state.shownIds.includes(p.id));

  if (unseenPhotos.length === 0) {
    updateControlsUI();
    return;
  }

  els.anotherBtn.disabled = true;
  els.anotherBtn.textContent = "Loading memory...";

  try {
    const [nextPhoto] = pickRandomItems(unseenPhotos, 1);

    state.todaysBatchIds.push(nextPhoto.id);
    state.shownIds.push(nextPhoto.id);
    saveDailyState(state);

    await appendPhotoCard(nextPhoto, true);
  } catch (err) {
    if (err.message === "SESSION_EXPIRED") {
      tokenClient.requestAccessToken({ prompt: "" });
    } else {
      showError("Could not load another photo: " + err.message);
    }
  } finally {
    els.anotherBtn.disabled = false;
    els.anotherBtn.textContent = "✨ Show me another memory";
    updateControlsUI();
  }
}

async function appendPhotoCard(file, scrollIntoView = false) {
  // Fetch image binary directly from Google Drive API using OAuth token
  const mediaUrl = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`;
  const res = await driveFetch(mediaUrl);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  activeBlobUrls.push(objectUrl);

  // Format EXIF capture date or Drive upload date
  const rawDate = file.imageMediaMetadata?.time || file.createdTime;
  const formattedDate = formatPhotoDate(rawDate);

  const card = document.createElement("article");
  card.className = "photo-card";
  card.innerHTML = `
    <div class="photo-wrapper">
      <img src="${objectUrl}" alt="${escapeHtml(file.name)}" loading="lazy" />
    </div>
    <div class="photo-meta">
      <span class="photo-date">${formattedDate}</span>
      <span>Tap to expand</span>
    </div>
  `;

  card.querySelector("img").addEventListener("click", () => {
    openLightbox(objectUrl, `${formattedDate} — ${file.name}`);
  });

  els.photosFeed.appendChild(card);

  if (scrollIntoView) {
    card.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function updateControlsUI() {
  const state = getDailyState();
  const remaining = allFolderPhotos.filter((p) => !state.shownIds.includes(p.id)).length;

  if (remaining === 0) {
    els.anotherBtn.disabled = true;
    els.anotherBtn.textContent = "All photos shown for today 🎉";
    els.remainingCount.textContent = "Come back tomorrow for a fresh set of memories.";
  } else {
    els.anotherBtn.disabled = false;
    els.remainingCount.textContent = `${remaining} unseen ${remaining === 1 ? "photo" : "photos"} left today`;
  }
}

function clearFeed() {
  els.photosFeed.innerHTML = "";
  activeBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  activeBlobUrls = [];
}

function showError(msg) {
  els.errorMessage.textContent = msg;
  els.errorBanner.classList.remove("hidden");
}

// ============================================================================
// HELPERS & LIGHTBOX
// ============================================================================
function formatPhotoDate(dateStr) {
  if (!dateStr) return "Shared Memory";
  // EXIF timestamps often use "YYYY:MM:DD HH:MM:SS"
  const normalized = dateStr.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3");
  const date = new Date(normalized);
  if (isNaN(date.getTime())) return "Shared Memory";

  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}

function openLightbox(src, caption) {
  els.lightboxImg.src = src;
  els.lightboxCaption.textContent = caption;
  els.lightbox.classList.remove("hidden");
}

function closeLightbox() {
  els.lightbox.classList.add("hidden");
  els.lightboxImg.src = "";
}
