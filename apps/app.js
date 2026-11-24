(() => {
  'use strict';

  const CLIENT_ID = '402006802634-ic218vn97iho61k7b511g2eicl4noa6q.apps.googleusercontent.com';
  const FAMILY_FOLDER_ID = '1AmO-d1qxzeaPYpo7GmpdKzCHQi4MX1mN';
  const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';
  const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3/files';

  // Folders whose subtrees are excluded from photo/video memory scanning
  const EXCLUDED_FOLDER_NAMES = [
    'Created content',
    'Audio tracks'
  ];

  // Folder names whose audio files are collected into the background audio pool
  const AUDIO_FOLDER_NAMES = [
    'Audio tracks'
  ];

  const IGNORED_EXTENSIONS = new Set([
    'mepj'
  ]);

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
  const AUDIO_EXTENSIONS = new Set([
    'mp3',
    'm4a',
    'aac',
    'wav',
    'ogg',
    'flac',
    'wma'
  ]);

  const STORAGE_KEYS = {
    RECENT_SURPRISE: 'dm_recent_surprise_ids_v1'
  };

  const state = {
    accessToken: null,
    tokenClient: null,
    allPhotos: [],
    allVideos: [],
    allAudioTracks: [],
    dailyPhotos: [],
    dailyVideo: null,
    currentSlideIndex: 0,
    slideTimer: null,
    objectUrls: new Set(),
    audioElement: new Audio(),
    currentAudioTrack: null,
    isAudioPlaying: false
  };

  state.audioElement.loop = false;

  // DOM References
  const dom = {
    headerActions: document.getElementById('header-actions'),
    audioToggleBtn: document.getElementById('audio-toggle-btn'),
    audioNextBtn: document.getElementById('audio-next-btn'),
    audioIcon: document.getElementById('audio-icon'),
    audioTrackLabel: document.getElementById('audio-track-label'),
    signOutBtn: document.getElementById('sign-out-btn'),

    authView: document.getElementById('auth-view'),
    signInBtn: document.getElementById('sign-in-btn'),
    authError: document.getElementById('auth-error'),

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

  function isExcludedFolderName(name) {
    const normalized = (name || '').trim().toLowerCase();
    return EXCLUDED_FOLDER_NAMES.some((entry) => entry.trim().toLowerCase() === normalized);
  }

  function isAudioFolderName(name) {
    const normalized = (name || '').trim().toLowerCase();
    return AUDIO_FOLDER_NAMES.some((entry) => entry.trim().toLowerCase() === normalized);
  }

  function getFileExtension(fileName) {
    const lower = (fileName || '').toLowerCase();
    return lower.includes('.') ? lower.split('.').pop() : '';
  }

  // View Switcher
  function showView(viewName) {
    dom.authView.hidden = viewName !== 'auth';
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
    loadFamilyArchive();
  }

  function triggerSignIn() {
    if (!state.tokenClient) {
      dom.authError.textContent = 'Google authentication is still loading. Try again in a moment.';
      dom.authError.hidden = false;
      return;
    }
    state.tokenClient.requestAccessToken({ prompt: '' });
  }

  function stopAudioPlayback() {
    state.audioElement.pause();
    state.audioElement.removeAttribute('src');
    state.currentAudioTrack = null;
    state.isAudioPlaying = false;
    updateAudioControlsUi();
  }

  function signOut() {
    stopSlideshowTimer();
    stopAudioPlayback();
    revokeAllObjectUrls();
    if (state.accessToken && window.google && window.google.accounts) {
      window.google.accounts.oauth2.revoke(state.accessToken, () => {});
    }
    state.accessToken = null;
    state.allPhotos = [];
    state.allVideos = [];
    state.allAudioTracks = [];
    state.dailyPhotos = [];
    state.dailyVideo = null;
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

  // Media Classification
  function classifyMediaFile(file, insideAudioFolder) {
    const ext = getFileExtension(file.name);
    if (IGNORED_EXTENSIONS.has(ext)) {
      return null;
    }

    const mime = (file.mimeType || '').toLowerCase();

    if (insideAudioFolder && (AUDIO_EXTENSIONS.has(ext) || mime.startsWith('audio/'))) {
      return { type: 'audio', isHeic: false };
    }

    if (insideAudioFolder) {
      return null;
    }

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
    const audioTracks = [];
    const visited = new Set([rootFolderId]);
    const queue = [{ id: rootFolderId, insideAudioFolder: false }];
    let scannedFolders = 0;

    while (queue.length > 0) {
      const current = queue.shift();
      scannedFolders += 1;
      dom.loadingStatus.textContent = `Scanned ${scannedFolders} folder${scannedFolders === 1 ? '' : 's'} • ${photos.length} photos, ${videos.length} videos, ${audioTracks.length} audio tracks`;

      const children = await listChildrenOfFolder(current.id);
      for (const item of children) {
        if (item.mimeType === 'application/vnd.google-apps.folder') {
          if (visited.has(item.id)) {
            continue;
          }

          if (isAudioFolderName(item.name)) {
            visited.add(item.id);
            queue.push({ id: item.id, insideAudioFolder: true });
            continue;
          }

          if (isExcludedFolderName(item.name)) {
            continue;
          }

          visited.add(item.id);
          queue.push({ id: item.id, insideAudioFolder: current.insideAudioFolder });
        } else {
          const mediaInfo = classifyMediaFile(item, current.insideAudioFolder);
          if (mediaInfo) {
            const enriched = {
              ...item,
              mediaType: mediaInfo.type,
              isHeic: mediaInfo.isHeic,
              displayDate: formatDisplayDate(item)
            };
            if (mediaInfo.type === 'photo') {
              photos.push(enriched);
            } else if (mediaInfo.type === 'video') {
              videos.push(enriched);
            } else if (mediaInfo.type === 'audio') {
              audioTracks.push(enriched);
            }
          }
        }
      }
    }

    photos.sort((a, b) => a.id.localeCompare(b.id));
    videos.sort((a, b) => a.id.localeCompare(b.id));
    audioTracks.sort((a, b) => a.id.localeCompare(b.id));

    return { photos, videos, audioTracks };
  }

  async function loadFamilyArchive() {
    showView('loading');
    dom.loadingTitle.textContent = "Curating Today's Memories";
    dom.loadingStatus.textContent = 'Scanning family archive...';

    try {
      const { photos, videos, audioTracks } = await scanFolderRecursively(FAMILY_FOLDER_ID);
      state.allPhotos = photos;
      state.allVideos = videos;
      state.allAudioTracks = audioTracks;

      prepareDailyMemories();
      renderDashboard();
      showView('memories');
      startRandomAudioTrack();
    } catch (err) {
      dom.loadingStatus.textContent = `Unable to load family archive: ${err.message}`;
    }
  }

  // Daily Selection (5 Photos + 1 Video preserved all day, rotates next day)
  function prepareDailyMemories() {
    const todayKey = getTodayKey();

    state.dailyPhotos = pickSeededSubset(
      state.allPhotos,
      5,
      `photos:${FAMILY_FOLDER_ID}:${todayKey}`
    );

    const videoSelection = pickSeededSubset(
      state.allVideos,
      1,
      `video:${FAMILY_FOLDER_ID}:${todayKey}`
    );
    state.dailyVideo = videoSelection.length ? videoSelection[0] : null;
  }

  // Random Audio Track Playback from "Audio tracks" folders
  function updateAudioControlsUi() {
    const hasAudio = state.allAudioTracks.length > 0;
    dom.audioToggleBtn.hidden = !hasAudio;
    dom.audioNextBtn.hidden = state.allAudioTracks.length <= 1;

    if (!hasAudio) return;

    const cleanName = state.currentAudioTrack
      ? state.currentAudioTrack.name.replace(/\.[^/.]+$/, '')
      : 'Audio';

    dom.audioIcon.textContent = state.isAudioPlaying ? '🔊' : '🔇';
    dom.audioTrackLabel.textContent = cleanName;
    dom.audioToggleBtn.classList.toggle('playing', state.isAudioPlaying);
  }

  async function startRandomAudioTrack() {
    if (!state.allAudioTracks.length) {
      updateAudioControlsUi();
      return;
    }

    let pool = state.allAudioTracks;
    if (state.currentAudioTrack && state.allAudioTracks.length > 1) {
      pool = state.allAudioTracks.filter((track) => track.id !== state.currentAudioTrack.id);
    }

    const chosen = pool[Math.floor(Math.random() * pool.length)];
    state.currentAudioTrack = chosen;
    updateAudioControlsUi();

    try {
      const blobUrl = await fetchAuthenticatedBlobUrl(chosen.id);
      if (state.currentAudioTrack?.id !== chosen.id) return;

      state.audioElement.src = blobUrl;
      await state.audioElement.play();
      state.isAudioPlaying = true;
      updateAudioControlsUi();
    } catch (err) {
      // Mobile browsers may block autoplay before user interaction; keep track ready to play
      state.isAudioPlaying = false;
      updateAudioControlsUi();
    }
  }

  async function toggleAudioPlayback() {
    if (!state.allAudioTracks.length) return;

    if (!state.currentAudioTrack || !state.audioElement.src) {
      await startRandomAudioTrack();
      return;
    }

    if (state.isAudioPlaying) {
      state.audioElement.pause();
      state.isAudioPlaying = false;
      updateAudioControlsUi();
    } else {
      try {
        await state.audioElement.play();
        state.isAudioPlaying = true;
      } catch (err) {
        state.isAudioPlaying = false;
      }
      updateAudioControlsUi();
    }
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
        '<div class="loader-inline">No photos found in archive</div>';
      dom.activePhotoDate.textContent = '';
      return;
    }

    state.dailyPhotos.forEach((photo, idx) => {
      const seg = document.createElement('div');
      seg.className = 'progress-segment';
      seg.innerHTML = '<div class="progress-fill"></div>';
      seg.addEventListener('click', () => goToSlide(idx));
      dom.slideshowProgress.appendChild(seg);

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
        void seg.offsetWidth;
        seg.classList.add('active');
      }
    });

    const activePhoto = state.dailyPhotos[index];
    dom.activePhotoDate.textContent =
      activePhoto && activePhoto.displayDate ? activePhoto.displayDate : '';
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

    if (state.dailyVideo.thumbnailLink) {
      const highResThumb = state.dailyVideo.thumbnailLink.replace(/=s\d+$/, '=s960');
      dom.dailyVideoThumb.src = highResThumb;
    } else {
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
    const maxHistory = Math.max(
      10,
      Math.floor((state.allPhotos.length + state.allVideos.length) * 0.6)
    );
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

    if (file.mediaType === 'video' && state.isAudioPlaying) {
      state.audioElement.pause();
      state.isAudioPlaying = false;
      updateAudioControlsUi();
    }

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

  // Event Listeners
  function bindEvents() {
    dom.signInBtn.addEventListener('click', triggerSignIn);
    dom.signOutBtn.addEventListener('click', signOut);
    dom.audioToggleBtn.addEventListener('click', toggleAudioPlayback);
    dom.audioNextBtn.addEventListener('click', startRandomAudioTrack);

    state.audioElement.addEventListener('ended', () => {
      startRandomAudioTrack();
    });

    dom.prevSlideBtn.addEventListener('click', () => goToSlide(state.currentSlideIndex - 1));
    dom.nextSlideBtn.addEventListener('click', () => goToSlide(state.currentSlideIndex + 1));

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
