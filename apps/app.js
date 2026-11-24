const CLIENT_ID = "402006802634-ic218vn97iho61k7b511g2eicl4noa6q.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/drive.readonly";

const STORAGE_KEYS = {
  FOLDER_ID: "dm_shared_folder_id",
  DAILY_STATE: "dm_daily_state_v2"
};

const SLIDE_INTERVAL_MS = 5000;

let tokenClient = null;
let accessToken = null;
let allPhotos = [];
let allVideos = [];
let activeBlobUrls = [];

let slideEntries = [];
let currentSlideIndex = 0;
let slideshowTimer = null;

let dailyVideoFile = null;
let dailyVideoThumbUrl = null;

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
  stage: document.getElementById("stage"),
  slideshowBox: document.getElementById("slideshow-box"),
  slidesLayer: document.getElementById("slides-layer"),
  heicBanner: document.getElementById("heic-banner"),
  heicFilename: document.getElementById("heic-filename"),
  slideCounter: document.getElementById("slide-counter"),
  slideDate: document.getElementById("slide-date"),
  videoSection: document.getElementById("video-section"),
  videoPosterCard: document.getElementById("video-poster-card"),
  videoThumbImg: document.getElementById("video-thumb-img"),
  videoThumbFallback: document.getElementById("video-thumb-fallback"),
  videoPlayTrigger: document.getElementById("video-play-trigger"),
  videoTitle: document.getElementById("video-title"),
  videoDate: document.getElementById("video-date"),
  surpriseBtn: document.getElementById("surprise-btn"),
  poolRemaining: document.getElementById("pool-remaining"),
  modal: document.getElementById("media-modal"),
  modalBadge: document.getElementById("modal-badge"),
  modalBody: document.getElementById("modal-body"),
  modalCaption: document.getElementById("modal-caption"),
  modalClose: document.getElementById("modal-close")
};

document.addEventListener("DOMContentLoaded", () => {
  const now = new Date();
  els.dateSubtitle.textContent = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

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
    stopSlideshow();
    cleanupStage();
    accessToken = null;
    allPhotos = [];
    allVideos = [];
    els.signoutBtn.classList.add("hidden");
    switchView("auth");
  });

  els.saveFolderBtn.addEventListener("click", handleSaveFolder);
  els.changeFolderBtn.addEventListener("click", () => {
    stopSlideshow();
    els.folderInput.value = localStorage.getItem(STORAGE_KEYS.FOLDER_ID) || "";
    switchView("setup");
  });

  els.retryBtn.addEventListener("click", () => loadDailyMemories());
  els.videoPosterCard.addEventListener("click", () => openDailyVideoModal());
  els.surpriseBtn.addEventListener("click", handleSurpriseMe);

  els.modalClose.addEventListener("click", closeModal);
  els.modal.querySelector(".modal-backdrop").addEventListener("click", closeModal);
}

function switchView(viewName) {
  Object.values(views).forEach((v) => v.classList.remove("active"));
  views[viewName].classList.add("active");
}

function extractFolderId(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/folders\/([a-zA-Z0-9_-]+)/);
  if (urlMatch && urlMatch[1]) return urlMatch[1];

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

async function driveFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    throw new Error("SESSION_EXPIRED");
  }
  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || `Drive API Error (${res.status})`);
  }
  return res;
}

async function fetchMediaInFolder(rootFolderId) {
  const photos = [];
  const videos = [];
  const foldersToScan = [rootFolderId];
  const scannedFolders = new Set();

  while (foldersToScan.length > 0) {
    const currentFolderId = foldersToScan.shift();
    if (scannedFolders.has(currentFolderId)) continue;
    scannedFolders.add(currentFolderId);

    let pageToken = null;
    do {
      const q = encodeURIComponent(
        `'${currentFolderId}' in parents and trashed = false and (mimeType contains 'image/' or mimeType contains 'video/' or mimeType = 'application/vnd.google-apps.folder')`
      );
      const fields = encodeURIComponent(
        "nextPageToken, files(id, name, mimeType, createdTime, thumbnailLink, imageMediaMetadata(time))"
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
        } else if (file.mimeType.startsWith("video/")) {
          videos.push(file);
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }

  return { photos, videos };
}

function trackBlobUrl(url) {
  activeBlobUrls.push(url);
  return url;
}

async function fetchMediaBlobUrl(fileId) {
  const mediaUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
  const res = await driveFetch(mediaUrl);
  const blob = await res.blob();
  return trackBlobUrl(URL.createObjectURL(blob));
}

async function fetchThumbnailBlobUrl(file) {
  if (!file.thumbnailLink) return null;
  try {
    const res = await driveFetch(file.thumbnailLink);
    const blob = await res.blob();
    return trackBlobUrl(URL.createObjectURL(blob));
  } catch {
    return null;
  }
}

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
      if (
        parsed.date === today &&
        Array.isArray(parsed.photoIds) &&
        Array.isArray(parsed.shownIds)
      ) {
        return parsed;
      }
    }
  } catch {
    // Ignore storage errors
  }
  return {
    date: today,
    photoIds: [],
    videoId: null,
    shownIds: []
  };
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

async function loadDailyMemories() {
  switchView("memories");
  stopSlideshow();
  cleanupStage();
  els.errorBanner.classList.add("hidden");
  els.stage.classList.add("hidden");
  els.loader.classList.remove("hidden");

  const folderId = localStorage.getItem(STORAGE_KEYS.FOLDER_ID);

  try {
    const { photos, videos } = await fetchMediaInFolder(folderId);
    allPhotos = photos;
    allVideos = videos;

    if (allPhotos.length === 0 && allVideos.length === 0) {
      throw new Error("No photos or videos were found in this folder.");
    }

    els.poolStatus.textContent = `${allPhotos.length} photos · ${allVideos.length} videos`;

    const state = getDailyState();
    const photoMap = new Map(allPhotos.map((p) => [p.id, p]));
    const videoMap = new Map(allVideos.map((v) => [v.id, v]));

    let dailyPhotos = state.photoIds.map((id) => photoMap.get(id)).filter(Boolean);
    if (dailyPhotos.length === 0 && allPhotos.length > 0) {
      const unseenPhotos = allPhotos.filter((p) => !state.shownIds.includes(p.id));
      const pool = unseenPhotos.length > 0 ? unseenPhotos : allPhotos;
      dailyPhotos = pickRandomItems(pool, Math.min(5, pool.length));
      state.photoIds = dailyPhotos.map((p) => p.id);
    }

    let dailyVideo = state.videoId ? videoMap.get(state.videoId) : null;
    if (!dailyVideo && allVideos.length > 0) {
      const unseenVideos = allVideos.filter((v) => !state.shownIds.includes(v.id));
      const vPool = unseenVideos.length > 0 ? unseenVideos : allVideos;
      [dailyVideo] = pickRandomItems(vPool, 1);
      state.videoId = dailyVideo ? dailyVideo.id : null;
    }

    const idsToMark = [
      ...dailyPhotos.map((p) => p.id),
      ...(dailyVideo ? [dailyVideo.id] : [])
    ];
    state.shownIds = Array.from(new Set([...state.shownIds, ...idsToMark]));
    saveDailyState(state);

    slideEntries = [];
    for (const photo of dailyPhotos) {
      const entry = await buildSlideEntry(photo);
      slideEntries.push(entry);
    }

    renderSlideshowDom();
    await renderDailyVideoSection(dailyVideo);
    updateSurpriseHint();

    els.loader.classList.add("hidden");
    els.stage.classList.remove("hidden");

    if (slideEntries.length > 0) {
      currentSlideIndex = 0;
      activateSlide(0);
      startSlideshow();
    } else {
      els.slideshowBox.classList.add("hidden");
    }
  } catch (err) {
    els.loader.classList.add("hidden");
    if (err.message === "SESSION_EXPIRED") {
      tokenClient.requestAccessToken({ prompt: "" });
    } else {
      showError(err.message);
    }
  }
}

function isHeicFile(file) {
  const mime = (file.mimeType || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return mime.includes("heic") || mime.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif");
}

async function buildSlideEntry(file) {
  try {
    const blobUrl = await fetchMediaBlobUrl(file.id);
    const canDecode = await testImageCanDecode(blobUrl);

    if (!canDecode && isHeicFile(file)) {
      return { file, blobUrl: null, isHeicUnsupported: true };
    }
    return { file, blobUrl, isHeicUnsupported: false };
  } catch {
    if (isHeicFile(file)) {
      return { file, blobUrl: null, isHeicUnsupported: true };
    }
    return { file, blobUrl: null, isHeicUnsupported: false };
  }
}

function testImageCanDecode(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

function renderSlideshowDom() {
  els.slidesLayer.innerHTML = "";

  slideEntries.forEach((entry, idx) => {
    const slideEl = document.createElement("div");
    slideEl.className = "slide";
    slideEl.dataset.index = String(idx);

    if (entry.blobUrl && !entry.isHeicUnsupported) {
      const img = document.createElement("img");
      img.src = entry.blobUrl;
      img.alt = entry.file.name;
      slideEl.appendChild(img);
    }

    els.slidesLayer.appendChild(slideEl);
  });
}

function activateSlide(index) {
  if (slideEntries.length === 0) return;
  currentSlideIndex = index % slideEntries.length;
  const entry = slideEntries[currentSlideIndex];

  const allSlideEls = els.slidesLayer.querySelectorAll(".slide");
  allSlideEls.forEach((el, i) => {
    const isCurrent = i === currentSlideIndex;
    el.classList.toggle("active", isCurrent);
    el.classList.remove("ken-burns");
    if (isCurrent && !entry.isHeicUnsupported) {
      void el.offsetWidth;
      el.classList.add("ken-burns");
    }
  });

  if (entry.isHeicUnsupported) {
    els.heicFilename.textContent = entry.file.name;
    els.heicBanner.classList.remove("hidden");
  } else {
    els.heicBanner.classList.add("hidden");
  }

  els.slideCounter.textContent = `${currentSlideIndex + 1} / ${slideEntries.length}`;
  els.slideDate.textContent = formatPhotoDate(
    entry.file.imageMediaMetadata?.time || entry.file.createdTime
  );
}

function startSlideshow() {
  stopSlideshow();
  if (slideEntries.length <= 1) return;
  slideshowTimer = setInterval(() => {
    activateSlide((currentSlideIndex + 1) % slideEntries.length);
  }, SLIDE_INTERVAL_MS);
}

function stopSlideshow() {
  if (slideshowTimer) {
    clearInterval(slideshowTimer);
    slideshowTimer = null;
  }
}

async function renderDailyVideoSection(videoFile) {
  dailyVideoFile = videoFile;
  dailyVideoThumbUrl = null;

  if (!videoFile) {
    els.videoSection.classList.add("hidden");
    return;
  }

  els.videoSection.classList.remove("hidden");
  els.videoTitle.textContent = videoFile.name;
  els.videoDate.textContent = formatPhotoDate(videoFile.createdTime);

  const thumbUrl = await fetchThumbnailBlobUrl(videoFile);
  if (thumbUrl) {
    dailyVideoThumbUrl = thumbUrl;
    els.videoThumbImg.src = thumbUrl;
    els.videoThumbImg.classList.remove("hidden");
    els.videoThumbFallback.classList.add("hidden");
  } else {
    els.videoThumbImg.classList.add("hidden");
    els.videoThumbFallback.classList.remove("hidden");
  }
}

async function openDailyVideoModal() {
  if (!dailyVideoFile) return;

  els.modalBadge.textContent = "Daily Video";
  els.modalCaption.textContent = `${formatPhotoDate(dailyVideoFile.createdTime)} — ${dailyVideoFile.name}`;
  els.modalBody.innerHTML = `<div class="spinner"></div>`;
  els.modal.classList.remove("hidden");

  try {
    const videoUrl = await fetchMediaBlobUrl(dailyVideoFile.id);
    els.modalBody.innerHTML = "";
    const videoEl = document.createElement("video");
    videoEl.src = videoUrl;
    videoEl.controls = true;
    videoEl.playsInline = true;
    videoEl.preload = "metadata";
    if (dailyVideoThumbUrl) {
      videoEl.poster = dailyVideoThumbUrl;
    }
    videoEl.autoplay = false;
    els.modalBody.appendChild(videoEl);
  } catch (err) {
    els.modalBody.innerHTML = `<p class="error-text" style="padding:16px;">Could not load video: ${escapeHtml(err.message)}</p>`;
  }
}

async function handleSurpriseMe() {
  const combined = [...allPhotos, ...allVideos];
  if (combined.length === 0) return;

  const state = getDailyState();
  let candidates = combined.filter((item) => !state.shownIds.includes(item.id));
  if (candidates.length === 0) {
    candidates = combined;
  }

  const [picked] = pickRandomItems(candidates, 1);

  if (!state.shownIds.includes(picked.id)) {
    state.shownIds.push(picked.id);
    saveDailyState(state);
    updateSurpriseHint();
  }

  const isVideo = (picked.mimeType || "").startsWith("video/");
  els.modalBadge.textContent = isVideo ? "🎲 Surprise Video" : "🎲 Surprise Photo";
  els.modalCaption.textContent = `${formatPhotoDate(picked.imageMediaMetadata?.time || picked.createdTime)} — ${picked.name}`;
  els.modalBody.innerHTML = `<div class="spinner"></div>`;
  els.modal.classList.remove("hidden");

  try {
    const mediaUrl = await fetchMediaBlobUrl(picked.id);
    els.modalBody.innerHTML = "";

    if (isVideo) {
      const videoEl = document.createElement("video");
      videoEl.src = mediaUrl;
      videoEl.controls = true;
      videoEl.playsInline = true;
      videoEl.preload = "metadata";
      videoEl.autoplay = false;
      els.modalBody.appendChild(videoEl);
    } else {
      const canDecode = await testImageCanDecode(mediaUrl);
      if (!canDecode && isHeicFile(picked)) {
        els.modalBody.innerHTML = `
          <div class="modal-heic-card">
            <span class="heic-icon">📱</span>
            <div class="heic-copy">
              <strong>HEIC image - view on iPhone</strong>
              <span>${escapeHtml(picked.name)}</span>
            </div>
          </div>
        `;
      } else {
        const imgEl = document.createElement("img");
        imgEl.src = mediaUrl;
        imgEl.alt = picked.name;
        els.modalBody.appendChild(imgEl);
      }
    }
  } catch (err) {
    els.modalBody.innerHTML = `<p class="error-text" style="padding:16px;">Could not load memory: ${escapeHtml(err.message)}</p>`;
  }
}

function closeModal() {
  const videoEl = els.modalBody.querySelector("video");
  if (videoEl) {
    videoEl.pause();
    videoEl.removeAttribute("src");
    videoEl.load();
  }
  els.modalBody.innerHTML = "";
  els.modal.classList.add("hidden");
}

function updateSurpriseHint() {
  const state = getDailyState();
  const total = allPhotos.length + allVideos.length;
  const unseen = Math.max(0, total - state.shownIds.length);
  els.poolRemaining.textContent = `${unseen} unseen ${unseen === 1 ? "item" : "items"} remaining today`;
}

function cleanupStage() {
  els.slidesLayer.innerHTML = "";
  els.heicBanner.classList.add("hidden");
  els.slideshowBox.classList.remove("hidden");
  activeBlobUrls.forEach((url) => URL.revokeObjectURL(url));
  activeBlobUrls = [];
  slideEntries = [];
  dailyVideoFile = null;
  dailyVideoThumbUrl = null;
}

function showError(msg) {
  els.errorMessage.textContent = msg;
  els.errorBanner.classList.remove("hidden");
}

function formatPhotoDate(dateStr) {
  if (!dateStr) return "Shared Memory";
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
  return String(str).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[m]));
}
