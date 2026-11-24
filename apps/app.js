(() => {
  'use strict';

  const CLIENT_ID = '402006802634-ic218vn97iho61k7b511g2eicl4noa6q.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
  const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';

  const PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'heic']);
  const VIDEO_EXTENSIONS = new Set([
    'mp4',
    'mov',
    'm4v',
    'webm',
    'avi',
    'mkv',
    '3gp',
    'wmv',
    'flv'
  ]);

  const STORAGE_KEYS = {
    FOLDER: 'dm_selected_folder_v1',
    RECENT_SURPRISE: 'dm_recent_surprise_ids_v1'
  };

  const state = {
    accessToken: null,
    tokenClient: null,
    selectedFolder: null,
    allPhotos: [],
    allVideos: [],
    dailyPhotos: [],
    dailyVideo: null,
    currentSlideIndex: 0,
    slideTimer: null,
    objectUrls: new Set()
  };

  // DOM References
  const dom = {
    headerActions: document.getElementById('header-actions'),
    currentFolderLabel: document.getElementById('current-folder-label'),
    changeFolderBtn: document.getElementById('change-folder-btn'),
    signOutBtn: document.getElementById('sign-out-btn'),

    authView: document.getElementById('auth-view'),
    signInBtn: document.getElementById('sign-in-btn'),
    authError: document.getElementById('auth-error'),

    folderView: document.getElementById('folder-view'),
    folderSearchInput: document.getElementById('folder-search-input'),
    useIdBtn: document.getElementById('use-id-btn'),
    folderList: document.getElementById('folder-list'),

    loadingView: document.getElementById('loading-view'),
    loadingTitle: document.getElementById('loading-title'),
    loadingStatus: document.getElementById('loading-status'),

    memoriesView: document.getElementById('memories-view'),
    slideshowProgress: document.getElementById('slideshow-progress'),
    slideshowStage: document.getElementById('slideshow-stage'),
    todayDateLabel: document.getElementById('today-date-label'),
    activePhotoDate: document.getElementById('active-photo-date'),
    prevSlideBtn: document.getElementById('prev-slide-btn'),
    nextSlideBtn: document.getElementById('next-slide-btn'),

    videoTrigger: document.getElementById('video-trigger'),
    dailyVideoThumb: document.getElementById('daily-video-thumb'),
    dailyVideoDate: document.getElementById('daily-video-date'),
    noVideoState: document.getElementById('no-video-state'),
    surpriseBtn: document.getElementById('surprise-btn'),

    mediaModal: document.getElementById('media-modal'),
    modalBadge: document.getElementById('modal-badge'),
    modalDate: document.getElementById('modal-date'),
    modalAnotherBtn: document.getElementById('modal-another-btn'),
    closeModalBtn: document.getElementById('close-modal-btn'),
    modalBody: document.getElementById('modal-body')
  };

  // View Switcher
  function showView(viewName) {
    dom.authView.hidden = viewName !== 'auth';
    dom.folderView.hidden = viewName !== 'folder';
    dom.loadingView.hidden = viewName !== 'loading';
    dom.memoriesView.hidden = viewName !== 'memories';
    dom.headerActions.hidden = viewName === 'auth';
  }

  // Date Utilities
  function getTodayKey() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function formatDisplayDate(file) {
    const rawDate =
      (file.imageMediaMetadata && file.imageMediaMetadata.time) ||
      file.createdTime ||
      file.modifiedTime;

    if (!rawDate) {
      return '';
    }

    // Handle EXIF format "YYYY:MM:DD HH:MM:SS"
    const normalized = rawDate.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
    const parsed = new Date(normalized);
    if (Number.isNaN(parsed.getTime())) {
      return '';
    }

    return parsed.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  // Deterministic Seeded PRNG (Mulberry32) so selections stay identical all day
  function hashSeed(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i += 1) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  }

  function createSeededRandom(seedStr) {
    let a = hashSeed(seedStr);
    return function nextRandom() {
      let t = (a += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function pickSeededSubset(items, count, seedStr) {
    if (!items.length) return [];
    const rng = createSeededRandom(seedStr);
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, Math.min(count, copy.length));
  }

  // Google OAuth Initialization
  function initGoogleAuth() {
    if (!window.google || !window.google.accounts || !window.google.accounts.oauth2) {
      setTimeout(initGoogleAuth, 150);
      return;
    }

    state.tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: handleAuthResponse
    });
  }

  function handleAuthResponse(response) {
    if (response.error || !response.access_token) {
      dom.authError.textContent = 'Google sign-in failed. Please try again.';
      dom.authError.hidden = false;
      return;
    }

    dom.authError.hidden = true;
    state.accessToken = response.access_token;

    const savedFolderRaw = localStorage.getItem(STORAGE_KEYS.FOLDER);
    if (savedFolderRaw) {
      try {
        const savedFolder = JSON.parse(savedFolderRaw);
        if (savedFolder && savedFolder.id) {
          selectFolderAndLoad(savedFolder);
          return;
        }
      } catch (err) {
        localStorage.removeItem(STORAGE_KEYS.FOLDER);
      }
    }

    openFolderPicker();
  }

  function triggerSignIn() {
    if (!state.tokenClient) {
      dom.authError.textContent = 'Google authentication is still loading. Try again in a moment.';
      dom.authError.hidden = false;
      return;
    }
    state.tokenClient.requestAccessToken({ prompt: '' });
  }

  function signOut() {
    stopSlideshowTimer();
    revokeAllObjectUrls();
    if (state.accessToken && window.google && window.google.accounts) {
      window.google.accounts.oauth2.revoke(state.accessToken, () => {});
    }
    state.accessToken = null;
    state.selectedFolder = null;
    localStorage.removeItem(STORAGE_KEYS.FOLDER);
    showView('auth');
  }

  // Google Drive API Helpers
  async function driveFetchJson(url) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${state.accessToken}`
      }
    });

    if (res.status === 401) {
      state.accessToken = null;
      showView('auth');
      throw new Error('Session expired. Please sign in again.');
    }

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Drive API error (${res.status}): ${errText}`);
    }

    return res.json();
  }

  async function fetchAuthenticatedBlobUrl(fileId) {
    const url = `${DRIVE_API_BASE}/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${state.accessToken}`
      }
    });

    if (!res.ok) {
      throw new Error(`Media download failed (${res.status})`);
    }

    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    state.objectUrls.add(objectUrl);
    return objectUrl;
  }

  function revokeAllObjectUrls() {
    state.objectUrls.forEach((url) => URL.revokeObjectURL(url));
    state.objectUrls.clear();
  }

  // Folder Picker Logic (Supports Shared With Me & My Drive)
  async function openFolderPicker(searchTerm = '') {
    stopSlideshowTimer();
    showView('folder');
    dom.folderList.innerHTML = '<div class="loader-inline">Loading shared & Drive folders...</div>';

    try {
      const escapedSearch = searchTerm.replace(/'/g, "\\'");
      let query = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
      if (escapedSearch) {
        query += ` and name contains '${escapedSearch}'`;
      } else {
        query += ' and (sharedWithMe = true or "root" in parents)';
      }

      const params = new URLSearchParams({
        q: query,
        fields: 'files(id, name, shared, sharedWithMeTime, owners(displayName))',
        orderBy: 'sharedWithMeTime desc, modifiedTime desc',
        pageSize: '40',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true'
      });

      const data = await driveFetchJson(`${DRIVE_API_BASE}?${params.toString()}`);
      renderFolderList(data.files || []);
    } catch (err) {
      dom.folderList.innerHTML = `<div class="loader-inline">${err.message}</div>`;
    }
  }

  function renderFolderList(folders) {
    if (!folders.length) {
      dom.folderList.innerHTML =
        '<div class="loader-inline">No matching folders found. Try searching or pasting a folder ID/URL above.</div>';
      return;
    }

    dom.folderList.innerHTML = '';
    folders.forEach((folder) => {
      const item = document.createElement('div');
      item.className = 'folder-item';

      const isShared = Boolean(folder.shared || folder.sharedWithMeTime);
      item.innerHTML = `
        <div class="folder-item-left">
          <span>📁</span>
          <span class="folder-name">${escapeHtml(folder.name)}</span>
        </div>
        ${isShared ? '<span class="shared-pill">Shared</span>' : ''}
      `;

      item.addEventListener('click', () => {
        selectFolderAndLoad({ id: folder.id, name: folder.name });
      });

      dom.folderList.appendChild(item);
    });
  }

  function extractFolderId(input) {
    const trimmed = input.trim();
    const urlMatch = trimmed.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (urlMatch) return urlMatch[1];
    const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idParamMatch) return idParamMatch[1];
    if (/^[a-zA-Z0-9_-]{15,}$/.test(trimmed)) return trimmed;
    return null;
  }

  async function handleFolderSearchOrOpen() {
    const rawValue = dom.folderSearchInput.value.trim();
    if (!rawValue) {
      openFolderPicker();
      return;
    }

    const extractedId = extractFolderId(rawValue);
    if (extractedId) {
      try {
        const params = new URLSearchParams({
          fields: 'id, name, mimeType',
          supportsAllDrives: 'true'
        });
        const folderMeta = await driveFetchJson(
          `${DRIVE_API_BASE}/${encodeURIComponent(extractedId)}?${params.toString()}`
        );
        if (folderMeta.mimeType === 'application/vnd.google-apps.folder') {
          selectFolderAndLoad({ id: folderMeta.id, name: folderMeta.name });
          return;
        }
      } catch (err) {
        // Fallback to name search
      }
    }

    openFolderPicker(rawValue);
  }

  // Recursive Folder Scanner
  function classifyMediaFile(file) {
    const name = (file.name || '').toLowerCase();
    const mime = (file.mimeType || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';

    if (ext === 'heic' || mime === 'image/heic' || mime === 'image/heif') {
      return { type: 'photo', isHeic: true };
    }

    if (PHOTO_EXTENSIONS.has(ext) || mime.startsWith('image/')) {
      return { type: 'photo', isHeic: false };
    }

    if (VIDEO_EXTENSIONS.has(ext) || mime.startsWith('video/')) {
      return { type: 'video', isHeic: false };
    }

    return null;
  }

  async function listChildrenOfFolder(folderId) {
    const allItems = [];
    let pageToken = null;

    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields:
          'nextPageToken, files(id, name, mimeType, createdTime, modifiedTime, thumbnailLink, imageMediaMetadata(time))',
        pageSize: '200',
        includeItemsFromAllDrives: 'true',
        supportsAllDrives: 'true'
      });

      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const data = await driveFetchJson(`${DRIVE_API_BASE}?${params.toString()}`);
      if (data.files && data.files.length) {
        allItems.push(...data.files);
      }
      pageToken = data.nextPageToken || null;
    } while (pageToken);

    return allItems;
  }

  async function scanFolderRecursively(rootFolderId) {
    const photos = [];
    const videos = [];
    const visited = new Set([rootFolderId]);
    const queue = [rootFolderId];
    let scannedFolders = 0;

    while (queue.length > 0) {
      const currentId = queue.shift();
      scannedFolders += 1;
      dom.loadingStatus.textContent = `Scanned ${scannedFolders} folder${scannedFolders === 1 ? '' : 's'} • Found ${photos.length} photos & ${videos.length} videos`;

      const children = await listChildrenOfFolder(currentId);
      for (const item of children) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          if (!visited.has(item.id)) {
            visited.add(item.id);
            queue.push(item.id);
          }
        } else {
          const mediaInfo = classifyMediaFile(item);
          if (mediaInfo) {
            const enriched = {
              ...item,
              mediaType: mediaInfo.type,
              isHeic: mediaInfo.isHeic,
              displayDate: formatDisplayDate(item)
            };
            if (mediaInfo.type === 'photo') {
              photos.push(enriched);
            } else {
              videos.push(enriched);
            }
          }
        }
      }
    }

    // Sort deterministically by ID before daily seeded selection
    photos.sort((a, b) => a.id.localeCompare(b.id));
    videos.sort((a, b) => a.id.localeCompare(b.id));

    return { photos, videos };
  }

  async function selectFolderAndLoad(folder) {
    state.selectedFolder = folder;
    localStorage.setItem(STORAGE_KEYS.FOLDER, JSON.stringify(folder));
    dom.currentFolderLabel.textContent = folder.name;

    showView('loading');
    dom.loadingTitle.textContent = `Scanning "${folder.name}"`;
    dom.loadingStatus.textContent = 'Searching subfolders for memories...';

    try {
      const { photos, videos } = await scanFolderRecursively(folder.id);
      state.allPhotos = photos;
      state.allVideos = videos;

      if (!photos.length && !videos.length) {
        dom.loadingStatus.textContent =
          'No supported photos or videos were found in this folder. Pick another folder.';
        setTimeout(() => openFolderPicker(), 1800);
        return;
      }

      prepareDailyMemories();
      renderDashboard();
      showView('memories');
    } catch (err) {
      dom.loadingStatus.textContent = `Error scanning folder: ${err.message}`;
      setTimeout(() => openFolderPicker(), 2200);
    }
  }

  // Daily Selection (5 Photos + 1 Video preserved all day, rotates next day)
  function prepareDailyMemories() {
    const todayKey = getTodayKey();
    const folderId = state.selectedFolder.id;

    state.dailyPhotos = pickSeededSubset(
      state.allPhotos,
      5,
      `photos:${folderId}:${todayKey}`
    );

    const videoSelection = pickSeededSubset(
      state.allVideos,
      1,
      `video:${folderId}:${todayKey}`
    );
    state.dailyVideo = videoSelection.length ? videoSelection[0] : null;
  }

  // HEIC Fallback Helper
  function renderHeicPlaceholder(container) {
    container.innerHTML = `
      <div class="heic-placeholder">
        <div class="heic-icon">🖼️</div>
        <p>HEIC image - best viewed on iPhone</p>
      </div>
    `;
  }

  async function loadImageIntoElement(file, container) {
    try {
      const blobUrl = await fetchAuthenticatedBlobUrl(file.id);
      const img = document.createElement('img');
      img.alt = file.name || 'Memory photo';

      img.onload = () => {
        container.innerHTML = '';
        container.appendChild(img);
      };

      img.onerror = () => {
        if (file.isHeic) {
          renderHeicPlaceholder(container);
        } else {
          container.innerHTML = '<div class="loader-inline">Unable to display image</div>';
        }
      };

      img.src = blobUrl;
    } catch (err) {
      if (file.isHeic) {
        renderHeicPlaceholder(container);
      } else {
        container.innerHTML = '<div class="loader-inline">Could not load photo</div>';
      }
    }
  }

  // Render Dashboard (Slideshow + Daily Video)
  function renderDashboard() {
    revokeAllObjectUrls();
    stopSlideshowTimer();

    const todayFormatted = new Date().toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });
    dom.todayDateLabel.textContent = todayFormatted;

    renderSlideshow();
    renderDailyVideo();
  }

  function renderSlideshow() {
    dom.slideshowProgress.innerHTML = '';
    dom.slideshowStage.innerHTML = '';

    if (!state.dailyPhotos.length) {
      dom.slideshowStage.innerHTML =
        '<div class="loader-inline">No photos found in this folder</div>';
      dom.activePhotoDate.textContent = '';
      return;
    }

    state.dailyPhotos.forEach((photo, idx) => {
      // Progress Segment
      const seg = document.createElement('div');
      seg.className = 'progress-segment';
      seg.innerHTML = '<div class="progress-fill"></div>';
      seg.addEventListener('click', () => goToSlide(idx));
      dom.slideshowProgress.appendChild(seg);

      // Slide Container
      const slide = document.createElement('div');
      slide.className = 'slide-item';
      slide.innerHTML = '<div class="loader-inline">Loading memory...</div>';
      dom.slideshowStage.appendChild(slide);

      loadImageIntoElement(photo, slide);
    });

    state.currentSlideIndex = 0;
    activateSlide(0);
    startSlideshowTimer();
  }

  function activateSlide(index) {
    const slides = dom.slideshowStage.querySelectorAll('.slide-item');
    const segments = dom.slideshowProgress.querySelectorAll('.progress-segment');
    if (!slides.length) return;

    slides.forEach((slide, i) => {
      slide.classList.toggle('active', i === index);
    });

    segments.forEach((seg, i) => {
      seg.classList.remove('active', 'completed');
      if (i < index) {
        seg.classList.add('completed');
      } else if (i === index) {
        // Trigger reflow so animation restarts cleanly
        void seg.offsetWidth;
        seg.classList.add('active');
      }
    });

    const activePhoto = state.dailyPhotos[index];
    dom.activePhotoDate.textContent = activePhoto && activePhoto.displayDate
      ? activePhoto.displayDate
      : '';
  }

  function goToSlide(index) {
    const count = state.dailyPhotos.length;
    if (!count) return;
    state.currentSlideIndex = (index + count) % count;
    activateSlide(state.currentSlideIndex);
    startSlideshowTimer();
  }

  function startSlideshowTimer() {
    stopSlideshowTimer();
    if (state.dailyPhotos.length <= 1) return;
    state.slideTimer = setInterval(() => {
      goToSlide(state.currentSlideIndex + 1);
    }, 5000);
  }

  function stopSlideshowTimer() {
    if (state.slideTimer) {
      clearInterval(state.slideTimer);
      state.slideTimer = null;
    }
  }

  async function renderDailyVideo() {
    if (!state.dailyVideo) {
      dom.videoTrigger.hidden = true;
      dom.noVideoState.hidden = false;
      return;
    }

    dom.videoTrigger.hidden = false;
    dom.noVideoState.hidden = true;
    dom.dailyVideoDate.textContent = state.dailyVideo.displayDate || 'Tap to play';

    // Load large thumbnail
    if (state.dailyVideo.thumbnailLink) {
      const highResThumb = state.dailyVideo.thumbnailLink.replace(/=s\d+$/, '=s960');
      dom.dailyVideoThumb.src = highResThumb;
    } else {
      // Fallback: grab first frame via blob URL
      try {
        const videoBlobUrl = await fetchAuthenticatedBlobUrl(state.dailyVideo.id);
        const tempVideo = document.createElement('video');
        tempVideo.src = videoBlobUrl;
        tempVideo.muted = true;
        tempVideo.currentTime = 0.5;
        tempVideo.addEventListener('loadeddata', () => {
          const canvas = document.createElement('canvas');
          canvas.width = tempVideo.videoWidth || 640;
          canvas.height = tempVideo.videoHeight || 360;
          canvas.getContext('2d').drawImage(tempVideo, 0, 0, canvas.width, canvas.height);
          dom.dailyVideoThumb.src = canvas.toDataURL('image/jpeg');
        });
      } catch (err) {
        dom.dailyVideoThumb.removeAttribute('src');
      }
    }
  }

  // Surprise Me Selection (Avoids recently shown items)
  function getRecentSurpriseIds() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.RECENT_SURPRISE);
      return raw ? JSON.parse(raw) : [];
    } catch (err) {
      return [];
    }
  }

  function recordSurpriseId(id) {
    const recent = getRecentSurpriseIds().filter((existingId) => existingId !== id);
    recent.push(id);
    const maxHistory = Math.max(10, Math.floor((state.allPhotos.length + state.allVideos.length) * 0.6));
    const trimmed = recent.slice(-maxHistory);
    localStorage.setItem(STORAGE_KEYS.RECENT_SURPRISE, JSON.stringify(trimmed));
  }

  function pickSurpriseItem() {
    const combined = [...state.allPhotos, ...state.allVideos];
    if (!combined.length) return null;

    const dailyIds = new Set(state.dailyPhotos.map((p) => p.id));
    if (state.dailyVideo) dailyIds.add(state.dailyVideo.id);

    const recentIds = new Set(getRecentSurpriseIds());

    let candidates = combined.filter(
      (item) => !recentIds.has(item.id) && !dailyIds.has(item.id)
    );

    if (!candidates.length) {
      candidates = combined.filter((item) => !recentIds.has(item.id));
    }

    if (!candidates.length) {
      localStorage.removeItem(STORAGE_KEYS.RECENT_SURPRISE);
      candidates = combined;
    }

    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    recordSurpriseId(chosen.id);
    return chosen;
  }

  // Modal Overlay (Video Playback & Surprise Memories)
  async function openMediaModal(file, options = {}) {
    const { isSurprise = false } = options;
    stopSlideshowTimer();

    dom.modalBadge.textContent = isSurprise ? '🎲 Surprise Memory' : 'Featured Video';
    dom.modalDate.textContent = file.displayDate || '';
    dom.modalAnotherBtn.hidden = !isSurprise;
    dom.modalBody.innerHTML = '<div class="loader-inline">Loading memory...</div>';
    dom.mediaModal.hidden = false;

    if (file.mediaType === 'video') {
      try {
        const videoUrl = await fetchAuthenticatedBlobUrl(file.id);
        dom.modalBody.innerHTML = '';
        const videoEl = document.createElement('video');
        videoEl.src = videoUrl;
        videoEl.controls = true;
        videoEl.playsInline = true;
        videoEl.autoplay = true;
        dom.modalBody.appendChild(videoEl);
      } catch (err) {
        dom.modalBody.innerHTML = `<div class="loader-inline">Could not load video: ${err.message}</div>`;
      }
    } else {
      await loadImageIntoElement(file, dom.modalBody);
    }
  }

  function closeMediaModal() {
    const activeVideo = dom.modalBody.querySelector('video');
    if (activeVideo) {
      activeVideo.pause();
      activeVideo.src = '';
    }
    dom.modalBody.innerHTML = '';
    dom.mediaModal.hidden = true;
    startSlideshowTimer();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // Event Listeners
  function bindEvents() {
    dom.signInBtn.addEventListener('click', triggerSignIn);
    dom.signOutBtn.addEventListener('click', signOut);
    dom.changeFolderBtn.addEventListener('click', () => openFolderPicker());

    dom.useIdBtn.addEventListener('click', handleFolderSearchOrOpen);
    dom.folderSearchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        handleFolderSearchOrOpen();
      }
    });

    dom.prevSlideBtn.addEventListener('click', () => goToSlide(state.currentSlideIndex - 1));
    dom.nextSlideBtn.addEventListener('click', () => goToSlide(state.currentSlideIndex + 1));

    // Touch swipe support on slideshow
    let touchStartX = 0;
    dom.slideshowStage.addEventListener(
      'touchstart',
      (e) => {
        touchStartX = e.changedTouches[0].clientX;
      },
      { passive: true }
    );

    dom.slideshowStage.addEventListener(
      'touchend',
      (e) => {
        const deltaX = e.changedTouches[0].clientX - touchStartX;
        if (Math.abs(deltaX) > 40) {
          goToSlide(state.currentSlideIndex + (deltaX < 0 ? 1 : -1));
        }
      },
      { passive: true }
    );

    dom.videoTrigger.addEventListener('click', () => {
      if (state.dailyVideo) {
        openMediaModal(state.dailyVideo, { isSurprise: false });
      }
    });

    dom.videoTrigger.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && state.dailyVideo) {
        e.preventDefault();
        openMediaModal(state.dailyVideo, { isSurprise: false });
      }
    });

    dom.surpriseBtn.addEventListener('click', () => {
      const surpriseItem = pickSurpriseItem();
      if (surpriseItem) {
        openMediaModal(surpriseItem, { isSurprise: true });
      }
    });

    dom.modalAnotherBtn.addEventListener('click', () => {
      const surpriseItem = pickSurpriseItem();
      if (surpriseItem) {
        openMediaModal(surpriseItem, { isSurprise: true });
      }
    });

    dom.closeModalBtn.addEventListener('click', closeMediaModal);
    dom.mediaModal.addEventListener('click', (e) => {
      if (e.target === dom.mediaModal) {
        closeMediaModal();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !dom.mediaModal.hidden) {
        closeMediaModal();
      }
    });
  }

  // Initialize App
  bindEvents();
  initGoogleAuth();
})();
