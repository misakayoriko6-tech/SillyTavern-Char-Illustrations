import { getContext } from '../../../extensions.js';
import { eventSource, event_types } from '../../../../script.js';

// ==================== 0. 通用安全与转义工具 ====================
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

async function copyTextDirectly(text) {
    if (!text) return false;
    try {
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch (_) {}

    try {
        const textArea = document.createElement('textarea');
        textArea.value = text;
        textArea.style.position = 'fixed';
        textArea.style.top = '-9999px';
        textArea.style.left = '-9999px';
        textArea.setAttribute('readonly', '');
        document.body.appendChild(textArea);
        textArea.select();
        const success = document.execCommand('copy');
        document.body.removeChild(textArea);
        return success;
    } catch (e) {
        console.warn('[插图插件] 复制失败:', e);
        return false;
    }
}

function debounce(fn, delay = 250) {
    let timer = null;
    return function (...args) {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), delay);
    };
}

function base64ToBlob(base64) {
    if (base64 instanceof Blob) return base64;
    if (typeof base64 !== 'string') return null;

    try {
        let contentType = 'image/png';
        let rawBase64 = base64;

        if (base64.includes(';base64,')) {
            const parts = base64.split(';base64,');
            if (parts[0].includes(':')) {
                contentType = parts[0].split(':')[1];
            }
            rawBase64 = parts[1];
        } else if (base64.startsWith('data:')) {
            const match = base64.match(/^data:([^;]+);/);
            if (match) contentType = match[1];
            rawBase64 = base64.replace(/^data:[^;]+;base64,/, '');
        }

        const cleanStr = rawBase64.replace(/[\r\n\s]/g, '');
        const byteCharacters = window.atob(cleanStr);
        const sliceSize = 1024;
        const byteArrays = [];

        for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
            const slice = byteCharacters.slice(offset, offset + sliceSize);
            const byteNumbers = new Array(slice.length);
            for (let i = 0; i < slice.length; i++) {
                byteNumbers[i] = slice.charCodeAt(i);
            }
            byteArrays.push(new Uint8Array(byteNumbers));
        }

        return new Blob(byteArrays, { type: contentType });
    } catch (e) {
        console.warn('[插图插件] Base64 转 Blob 异常:', e);
        return base64;
    }
}

function blobToBase64(blob) {
    if (typeof blob === 'string') return Promise.resolve(blob);
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

async function getBlobFingerprint(blob) {
    if (!(blob instanceof Blob)) return null;
    const size = blob.size;
    const type = blob.type || '';
    if (size === 0) return `empty_0`;

    const sliceLen = Math.min(2048, size);
    const head = await blob.slice(0, sliceLen).arrayBuffer();
    const mid = await blob.slice(Math.floor(size / 2), Math.floor(size / 2) + sliceLen).arrayBuffer();
    const tail = await blob.slice(Math.max(0, size - sliceLen), size).arrayBuffer();

    const sample = new Uint8Array([...new Uint8Array(head), ...new Uint8Array(mid), ...new Uint8Array(tail)]);
    let hash = 0;
    for (let i = 0; i < sample.length; i++) {
        hash = ((hash << 5) - hash) + sample[i];
        hash |= 0;
    }
    return `${type}_${size}_${hash}`;
}

async function compressImageLossless(sourceBlob, quality = 0.985) {
    if (!(sourceBlob instanceof Blob)) return sourceBlob;
    if (sourceBlob.size < 400 * 1024) return sourceBlob;

    return new Promise((resolve) => {
        const url = URL.createObjectURL(sourceBlob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            try {
                const w = img.naturalWidth || img.width;
                const h = img.naturalHeight || img.height;
                if (w <= 0 || h <= 0) return resolve(sourceBlob);

                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;

                const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(img, 0, 0, w, h);

                canvas.toBlob((blob) => {
                    resolve(blob && blob.size < sourceBlob.size * 0.88 ? blob : sourceBlob);
                }, 'image/webp', quality);
            } catch (e) {
                resolve(sourceBlob);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(sourceBlob);
        };
        img.src = url;
    });
}

// 辅助：获取酒馆底层正文滚动容器
function getTavernScrollContainer() {
    return document.getElementById('chat') || document.querySelector('#chat') || window;
}

// 辅助：移动端手势纵向穿透与横向拖拽智能分流引擎
function attachTouchPassThrough(element) {
    if (!element) return;

    let touchStartX = 0;
    let touchStartY = 0;
    let lastTouchY = 0;
    let gestureDirection = null; // 'horizontal' | 'vertical' | null
    let targetScrollEl = null;

    element.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        lastTouchY = touch.clientY;
        gestureDirection = null;
        targetScrollEl = getTavernScrollContainer();
    }, { passive: true });

    element.addEventListener('touchmove', (e) => {
        if (e.touches.length !== 1) return;
        const touch = e.touches[0];
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;

        if (gestureDirection === null) {
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);
            if (absX > 6 || absY > 6) {
                gestureDirection = absX > absY ? 'horizontal' : 'vertical';
            }
        }

        if (gestureDirection === 'vertical') {
            const stepY = lastTouchY - touch.clientY;
            lastTouchY = touch.clientY;
            if (targetScrollEl) {
                if (targetScrollEl === window) {
                    window.scrollBy(0, stepY);
                } else {
                    targetScrollEl.scrollTop += stepY;
                }
            }
        }
    }, { passive: true });

    element.addEventListener('touchend', () => {
        gestureDirection = null;
    }, { passive: true });

    element.addEventListener('touchcancel', () => {
        gestureDirection = null;
    }, { passive: true });
}

// ==================== 1. 图像展示与生命周期管理 ====================
class ImageUrlManager {
    constructor(maxCacheSize = 80) {
        this.blobMap = new WeakMap();
        this.strCache = new Map();
        this.maxCacheSize = maxCacheSize;
        this.thumbUrlCache = new Map();
        this.modalThumbCache = new Map();
    }

    getUrl(source) {
        if (!source) return '';
        if (typeof source === 'string') {
            if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('/') || source.startsWith('blob:')) {
                return source;
            }
            let base64 = source.trim();
            if (!base64.startsWith('data:image')) {
                base64 = 'data:image/png;base64,' + base64;
            }
            if (this.strCache.has(base64)) {
                const url = this.strCache.get(base64);
                this.strCache.delete(base64);
                this.strCache.set(base64, url);
                return url;
            }
            try {
                const blob = base64ToBlob(base64);
                const url = URL.createObjectURL(blob);
                if (this.strCache.size >= this.maxCacheSize) {
                    const oldestKey = this.strCache.keys().next().value;
                    const oldUrl = this.strCache.get(oldestKey);
                    if (oldUrl?.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
                    this.strCache.delete(oldestKey);
                }
                this.strCache.set(base64, url);
                return url;
            } catch (e) {
                return base64;
            }
        }
        if (source instanceof Blob) {
            if (this.blobMap.has(source)) return this.blobMap.get(source);
            try {
                const url = URL.createObjectURL(source);
                this.blobMap.set(source, url);
                return url;
            } catch (e) {
                return '';
            }
        }
        return '';
    }

    async getManageThumbnailUrl(source, maxSize = 260, quality = 0.70) {
        if (!source) return '';
        const fullUrl = this.getUrl(source);
        if (this.modalThumbCache.has(fullUrl)) return this.modalThumbCache.get(fullUrl);

        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = async () => {
                try {
                    let w = img.width, h = img.height;
                    if (w > h) {
                        if (w > maxSize) { h = Math.round((h * maxSize) / w); w = maxSize; }
                    } else {
                        if (h > maxSize) { w = Math.round((w * maxSize) / h); h = maxSize; }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(w, 1);
                    canvas.height = Math.max(h, 1);
                    const ctx = canvas.getContext('2d', { alpha: false });
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'medium';
                    ctx.drawImage(img, 0, 0, w, h);

                    const toBlob = (c, mime, q) => new Promise(res => {
                        try { c.toBlob(b => res(b), mime, q); } catch (_) { res(null); }
                    });

                    let resultBlob = await toBlob(canvas, 'image/webp', quality) || await toBlob(canvas, 'image/jpeg', quality);
                    if (!resultBlob) return resolve(fullUrl);

                    const thumbUrl = URL.createObjectURL(resultBlob);
                    this.modalThumbCache.set(fullUrl, thumbUrl);
                    resolve(thumbUrl);
                } catch (err) {
                    resolve(fullUrl);
                }
            };
            img.onerror = () => resolve(fullUrl);
            img.src = fullUrl;
        });
    }

    async getThumbnailUrl(ruleId, imgIndex, source, maxSize = 180) {
        if (!source) return '';
        const cacheKey = `${ruleId}_${imgIndex}`;
        if (this.thumbUrlCache.has(cacheKey)) return this.thumbUrlCache.get(cacheKey);

        if (ruleId !== undefined && imgIndex !== undefined) {
            try {
                const cachedBlob = await dbGetStoredThumbnail(cacheKey);
                if (cachedBlob) {
                    const thumbUrl = URL.createObjectURL(cachedBlob);
                    this.thumbUrlCache.set(cacheKey, thumbUrl);
                    return thumbUrl;
                }
            } catch (_) {}
        }

        const fullUrl = this.getUrl(source);
        return new Promise((resolve) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = async () => {
                try {
                    let w = img.width, h = img.height;
                    if (w > h) {
                        if (w > maxSize) { h = Math.round((h * maxSize) / w); w = maxSize; }
                    } else {
                        if (h > maxSize) { w = Math.round((w * maxSize) / h); h = maxSize; }
                    }
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(w, 1);
                    canvas.height = Math.max(h, 1);
                    const ctx = canvas.getContext('2d', { alpha: false });
                    ctx.imageSmoothingEnabled = true;
                    ctx.imageSmoothingQuality = 'medium';
                    ctx.drawImage(img, 0, 0, w, h);

                    const toBlob = (c, mime, q) => new Promise(res => {
                        try { c.toBlob(b => res(b), mime, q); } catch (_) { res(null); }
                    });

                    let resultBlob = await toBlob(canvas, 'image/webp', 0.7) || await toBlob(canvas, 'image/jpeg', 0.7);
                    if (!resultBlob) return resolve(fullUrl);

                    const thumbUrl = URL.createObjectURL(resultBlob);
                    this.thumbUrlCache.set(cacheKey, thumbUrl);
                    if (ruleId !== undefined && imgIndex !== undefined) {
                        dbSaveStoredThumbnail(cacheKey, resultBlob).catch(() => {});
                    }
                    resolve(thumbUrl);
                } catch (err) {
                    resolve(fullUrl);
                }
            };
            img.onerror = () => resolve(fullUrl);
            img.src = fullUrl;
        });
    }

    clearRuleThumbnails(ruleId) {
        for (const [key, url] of this.thumbUrlCache.entries()) {
            if (String(key).startsWith(`${ruleId}_`)) {
                try { URL.revokeObjectURL(url); } catch (_) {}
                this.thumbUrlCache.delete(key);
            }
        }
    }

    clearCache() {
        const revokeAll = (cache) => {
            for (const url of cache.values()) {
                if (typeof url === 'string' && url.startsWith('blob:')) {
                    try { URL.revokeObjectURL(url); } catch (_) {}
                }
            }
            cache.clear();
        };
        revokeAll(this.strCache);
        revokeAll(this.thumbUrlCache);
        revokeAll(this.modalThumbCache);
    }
}

const urlManager = new ImageUrlManager(80);
function toDisplayUrl(source) { return urlManager.getUrl(source); }

// ==================== 2. 全屏图片灯箱 (纯净位移与多指隔离引擎) ====================
let viewerState = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    isDragging: false,
    lastX: 0,
    lastY: 0,
    initialDistance: 0,
    initialScale: 1,
    rafId: null
};

function initImageViewer() {
    if (document.getElementById('ci-lightbox-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'ci-lightbox-modal';
    modal.className = 'ci-lightbox';
    modal.innerHTML = `
        <div class="ci-lightbox-backdrop"></div>
        <div class="ci-lightbox-content">
            <img id="ci-lightbox-img" src="" alt="放大插图" draggable="false" />
        </div>
        <div class="ci-lightbox-close" title="关闭 (Esc)">×</div>
        <div class="ci-lightbox-hint">滚轮/双指缩放 · 拖拽移动 · 双击复位 · 单击背景关闭</div>
    `;
    document.body.appendChild(modal);

    const img = document.getElementById('ci-lightbox-img');
    const content = modal.querySelector('.ci-lightbox-content');
    const backdrop = modal.querySelector('.ci-lightbox-backdrop');
    const closeBtn = modal.querySelector('.ci-lightbox-close');

    function applyTransform() {
        img.style.transform = `translate3d(${viewerState.translateX}px, ${viewerState.translateY}px, 0) scale(${viewerState.scale})`;
    }

    function scheduleRender() {
        if (viewerState.rafId) return;
        viewerState.rafId = requestAnimationFrame(() => {
            applyTransform();
            viewerState.rafId = null;
        });
    }

    function resetTransform() {
        viewerState.scale = 1;
        viewerState.translateX = 0;
        viewerState.translateY = 0;
        viewerState.isDragging = false;
        applyTransform();
    }

    window.openCIModal = function(src) {
        img.src = toDisplayUrl(src);
        resetTransform();
        modal.classList.add('active');
    };

    function closeModal() {
        modal.classList.remove('active');
        img.src = '';
        viewerState.isDragging = false;
    }

    closeBtn.onclick = (e) => { e.stopPropagation(); closeModal(); };
    backdrop.onclick = (e) => { e.stopPropagation(); closeModal(); };

    modal.addEventListener('wheel', (e) => {
        if (!modal.classList.contains('active')) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        viewerState.scale = Math.min(Math.max(viewerState.scale * factor, 0.4), 8);
        scheduleRender();
    }, { passive: false });

    content.addEventListener('mousedown', (e) => {
        if (e.target !== img && e.target !== content) return;
        e.preventDefault();
        viewerState.isDragging = true;
        viewerState.lastX = e.clientX;
        viewerState.lastY = e.clientY;
    });

    window.addEventListener('mousemove', (e) => {
        if (!viewerState.isDragging) return;
        viewerState.translateX += (e.clientX - viewerState.lastX);
        viewerState.translateY += (e.clientY - viewerState.lastY);
        viewerState.lastX = e.clientX;
        viewerState.lastY = e.clientY;
        scheduleRender();
    }, { passive: true });

    window.addEventListener('mouseup', () => { viewerState.isDragging = false; }, { passive: true });

    const getTouchDist = (t1, t2) => Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);

    content.addEventListener('touchstart', (e) => {
        if (!modal.classList.contains('active')) return;
        if (e.touches.length === 1) {
            viewerState.isDragging = true;
            viewerState.lastX = e.touches[0].clientX;
            viewerState.lastY = e.touches[0].clientY;
        } else if (e.touches.length === 2) {
            viewerState.isDragging = false;
            viewerState.initialDistance = getTouchDist(e.touches[0], e.touches[1]);
            viewerState.initialScale = viewerState.scale;
        }
    }, { passive: false });

    content.addEventListener('touchmove', (e) => {
        if (!modal.classList.contains('active')) return;
        e.preventDefault();
        if (e.touches.length === 1 && viewerState.isDragging) {
            const curX = e.touches[0].clientX;
            const curY = e.touches[0].clientY;
            viewerState.translateX += (curX - viewerState.lastX);
            viewerState.translateY += (curY - viewerState.lastY);
            viewerState.lastX = curX;
            viewerState.lastY = curY;
            scheduleRender();
        } else if (e.touches.length === 2 && viewerState.initialDistance > 0) {
            const dist = getTouchDist(e.touches[0], e.touches[1]);
            viewerState.scale = Math.min(Math.max(viewerState.initialScale * (dist / viewerState.initialDistance), 0.4), 8);
            scheduleRender();
        }
    }, { passive: false });

    content.addEventListener('touchend', (e) => {
        if (e.touches.length === 0) {
            viewerState.isDragging = false;
            viewerState.initialDistance = 0;
        } else if (e.touches.length === 1) {
            viewerState.isDragging = true;
            viewerState.lastX = e.touches[0].clientX;
            viewerState.lastY = e.touches[0].clientY;
            viewerState.initialDistance = 0;
        }
    }, { passive: false });

    img.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        resetTransform();
    });

    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
    });
}

// ==================== 3. 规则与数据标准化 ====================
function parseRuleInput(inputStr) {
    if (!inputStr) return [];
    return inputStr
        .split(/[,，]/)
        .map(group => group.split('+').map(k => k.trim()).filter(Boolean))
        .filter(group => group.length > 0);
}

function cleanAndNormalizeRules(rulesInput) {
    if (!rulesInput) return [];
    const list = Array.isArray(rulesInput) ? rulesInput : parseRuleInput(rulesInput);
    const seenGroup = new Set();
    const result = [];

    for (const group of list) {
        const tokens = (Array.isArray(group) ? group : String(group).split('+')).map(k => String(k).trim()).filter(Boolean);
        if (tokens.length > 0) {
            const uniqueTokens = Array.from(new Set(tokens));
            const groupKey = uniqueTokens.slice().sort().join('+');
            if (!seenGroup.has(groupKey)) {
                seenGroup.add(groupKey);
                result.push(uniqueTokens);
            }
        }
    }
    return result;
}

function formatRuleDisplay(item) {
    const list = item.rules || item.keywords;
    if (Array.isArray(list)) {
        return list.map(group => (Array.isArray(group) ? group.join(' + ') : group)).join(', ');
    }
    return '';
}

function optimizeIllustrationRecord(rawItem, fallbackOrder = 1) {
    const rawImgs = rawItem.images || (rawItem.data ? [rawItem.data] : []);
    if (!rawImgs.length) return null;

    const blobImgs = rawImgs.map(img => (typeof img === 'string' && img.startsWith('data:image') ? base64ToBlob(img) : img));
    const cleanRules = cleanAndNormalizeRules(rawItem.rules || rawItem.keywords);
    if (!cleanRules.length) return null;

    const cleanNames = Array.isArray(rawItem.imageNames) ? [...rawItem.imageNames] : [];
    while (cleanNames.length < blobImgs.length) cleanNames.push('');
    if (cleanNames.length > blobImgs.length) cleanNames.length = blobImgs.length;

    let selectedIdx = typeof rawItem.selectedIndex === 'number' ? rawItem.selectedIndex : 0;
    if (selectedIdx < 0 || selectedIdx >= blobImgs.length) selectedIdx = 0;

    return {
        rules: cleanRules,
        images: blobImgs,
        imageNames: cleanNames,
        selectedIndex: selectedIdx,
        groupName: typeof rawItem.groupName === 'string' ? rawItem.groupName.trim() : '',
        order: typeof rawItem.order === 'number' ? rawItem.order : fallbackOrder,
        optimized: rawItem.optimized === true,
        createdAt: rawItem.createdAt || Date.now()
    };
}

// ==================== 4. IndexedDB 存储引擎 ====================
const DB_NAME = 'ST_Char_Illustrations_DB';
const STORE_NAME = 'illustrations';
const THUMB_STORE_NAME = 'thumbnails';
let dbInstance = null;
let dbInitPromise = null;
let cachedIllustrations = [];
let currentCachedCharId = null;
let searchFilterKeyword = '';
let searchInputValue = '';
let activeGroupFilter = '';

let cachedStorageStats = null;
let lastStatsCharId = null;

const activeSlideMemoryByChar = new Map();

function initDB() {
    if (dbInstance) {
        try {
            dbInstance.transaction([STORE_NAME], 'readonly');
            return Promise.resolve(dbInstance);
        } catch (e) {
            try { dbInstance.close(); } catch (_) {}
            dbInstance = null;
        }
    }
    if (dbInitPromise) return dbInitPromise;

    dbInitPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 3);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            let store = db.objectStoreNames.contains(STORE_NAME)
                ? e.target.transaction.objectStore(STORE_NAME)
                : db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            if (!store.indexNames.contains('charId')) store.createIndex('charId', 'charId', { unique: false });
            if (!store.indexNames.contains('order')) store.createIndex('order', 'order', { unique: false });
            if (!db.objectStoreNames.contains(THUMB_STORE_NAME)) db.createObjectStore(THUMB_STORE_NAME, { keyPath: 'key' });
        };
        req.onsuccess = (e) => {
            dbInstance = e.target.result;
            dbInitPromise = null;
            dbInstance.onversionchange = () => { try { dbInstance.close(); } catch (_) {} dbInstance = null; };
            dbInstance.onclose = () => { dbInstance = null; };
            dbInstance.onerror = () => { dbInstance = null; };
            resolve(dbInstance);
        };
        req.onerror = (e) => { dbInstance = null; dbInitPromise = null; reject(e); };
    });
    return dbInitPromise;
}

async function dbGetStoredThumbnail(key) {
    const db = await initDB();
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([THUMB_STORE_NAME], 'readonly');
            const req = tx.objectStore(THUMB_STORE_NAME).get(key);
            req.onsuccess = () => resolve(req.result ? req.result.blob : null);
            req.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
    });
}

async function dbSaveStoredThumbnail(key, blob) {
    const db = await initDB();
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([THUMB_STORE_NAME], 'readwrite');
            tx.objectStore(THUMB_STORE_NAME).put({ key, blob });
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        } catch (_) { resolve(); }
    });
}

async function dbClearThumbnailsForRule(ruleId) {
    urlManager.clearRuleThumbnails(ruleId);
    const db = await initDB();
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([THUMB_STORE_NAME], 'readwrite');
            const req = tx.objectStore(THUMB_STORE_NAME).openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (String(cursor.key).startsWith(`${ruleId}_`)) cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => resolve();
        } catch (_) { resolve(); }
    });
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function dbGetStorageStats(charId) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).openCursor();
            let totalBytes = 0, charBytes = 0, totalCount = 0;

            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const item = cursor.value;
                    totalCount++;
                    let size = 0;
                    for (const img of (item.images || [])) {
                        if (img instanceof Blob) size += img.size;
                        else if (typeof img === 'string') size += img.length * 2;
                    }
                    totalBytes += size;
                    if (item.charId === charId) charBytes += size;
                    cursor.continue();
                } else {
                    resolve({ charSize: formatBytes(charBytes), totalSize: formatBytes(totalBytes), totalCount });
                }
            };
            req.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

async function dbClearEntireDatabase() {
    if (dbInstance) {
        try { dbInstance.close(); } catch (_) {}
        dbInstance = null;
    }
    dbInitPromise = null;
    urlManager.clearCache();
    invalidateCache();
    cachedStorageStats = null;

    return new Promise((resolve, reject) => {
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => initDB().then(() => resolve()).catch(resolve);
        req.onerror = (e) => reject(e);
        req.onblocked = () => setTimeout(() => initDB().then(() => resolve()).catch(resolve), 300);
    });
}

async function dbAddIllustration(charId, rules, imagesData, imageNames = [], selectedIndex = 0, groupName = '') {
    const db = await initDB();
    const existing = await dbGetIllustrations(charId);
    const nextOrder = existing.length > 0 ? Math.max(...existing.map(i => i.order || 0)) + 1 : 1;
    const imagesList = Array.isArray(imagesData) ? imagesData : [imagesData];

    const blobList = imagesList.map(img => (typeof img === 'string' && img.startsWith('data:image') ? base64ToBlob(img) : img));
    const namesList = Array.isArray(imageNames) ? [...imageNames] : [];
    while (namesList.length < blobList.length) namesList.push('');

    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const req = tx.objectStore(STORE_NAME).add({
                charId,
                rules: cleanAndNormalizeRules(rules),
                images: blobList,
                imageNames: namesList,
                selectedIndex: selectedIndex || 0,
                groupName: (groupName || '').trim(),
                order: nextOrder,
                optimized: false,
                createdAt: Date.now()
            });
            req.onsuccess = () => {
                invalidateCache();
                cachedStorageStats = null;
                resolve(req.result);
            };
            req.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

async function dbBatchInsertItems(charId, batchRecords) {
    if (!batchRecords?.length) return 0;
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            let count = 0;
            for (const rec of batchRecords) {
                store.add({ charId, ...rec });
                count++;
            }
            tx.oncomplete = () => {
                cachedStorageStats = null;
                resolve(count);
            };
            tx.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

async function dbGetIllustrations(charId) {
    if (!charId) return [];
    if (currentCachedCharId === charId && cachedIllustrations.length > 0) {
        return cachedIllustrations;
    }
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readonly');
            const req = tx.objectStore(STORE_NAME).index('charId').getAll(IDBKeyRange.only(charId));
            req.onsuccess = () => {
                const res = req.result || [];
                res.forEach(item => {
                    if (!item.images) item.images = item.data ? [item.data] : [];
                    if (!Array.isArray(item.imageNames)) {
                        item.imageNames = new Array(item.images.length).fill('');
                    } else {
                        while (item.imageNames.length < item.images.length) item.imageNames.push('');
                    }
                    if (typeof item.selectedIndex !== 'number') item.selectedIndex = 0;
                    if (typeof item.groupName !== 'string') item.groupName = '';
                });
                res.sort((a, b) => (a.order ?? a.id) - (b.order ?? b.id));
                cachedIllustrations = res;
                currentCachedCharId = charId;
                resolve(cachedIllustrations);
            };
            req.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

function invalidateCache() {
    cachedIllustrations = [];
    currentCachedCharId = null;
}

async function dbUpdateIllustration(id, rules = null, order = null, newImages = null, imageNames = null, selectedIndex = null, groupName = null) {
    if (newImages !== null) {
        try { await dbClearThumbnailsForRule(id); } catch (_) {}
    }
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (!data) return reject(new Error('数据未找到'));
                if (rules !== null) {
                    data.rules = cleanAndNormalizeRules(rules);
                    delete data.keywords;
                }
                if (order !== null) data.order = order;
                if (newImages !== null) {
                    data.images = newImages.map(img => (typeof img === 'string' && img.startsWith('data:image') ? base64ToBlob(img) : img));
                    delete data.data;
                    data.optimized = false;
                    cachedStorageStats = null;
                }
                if (imageNames !== null) data.imageNames = imageNames;
                if (selectedIndex !== null) data.selectedIndex = selectedIndex;
                if (groupName !== null) data.groupName = groupName.trim();

                const putReq = store.put(data);
                putReq.onsuccess = () => {
                    invalidateCache();
                    resolve();
                };
                putReq.onerror = (e) => reject(e);
            };
            getReq.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

async function dbSetIllustrationSelectedIndex(id, index) {
    const db = await initDB();
    return new Promise((resolve) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const getReq = store.get(id);
            getReq.onsuccess = () => {
                const data = getReq.result;
                if (!data) return resolve();
                data.selectedIndex = index;
                const putReq = store.put(data);
                putReq.onsuccess = () => { invalidateCache(); resolve(); };
                putReq.onerror = () => resolve();
            };
            getReq.onerror = () => resolve();
        } catch (_) {
            dbInstance = null;
            resolve();
        }
    });
}

async function dbBatchSaveAll(updates) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const item of updates) {
                const getReq = store.get(item.id);
                getReq.onsuccess = () => {
                    const data = getReq.result;
                    if (data) {
                        if (item.rules) data.rules = cleanAndNormalizeRules(item.rules);
                        if (item.order !== undefined) data.order = item.order;
                        if (item.images) {
                            data.images = item.images.map(img => (typeof img === 'string' && img.startsWith('data:image') ? base64ToBlob(img) : img));
                            delete data.data;
                            data.optimized = false;
                            cachedStorageStats = null;
                        }
                        if (item.imageNames) data.imageNames = item.imageNames;
                        if (item.selectedIndex !== undefined) data.selectedIndex = item.selectedIndex;
                        if (item.groupName !== undefined) data.groupName = item.groupName.trim();
                        store.put(data);
                    }
                };
            }
            tx.oncomplete = () => { invalidateCache(); resolve(); };
            tx.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

async function dbDeleteIllustration(id) {
    const db = await initDB();
    await dbClearThumbnailsForRule(id);
    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const req = tx.objectStore(STORE_NAME).delete(id);
            req.onsuccess = () => {
                invalidateCache();
                cachedStorageStats = null;
                resolve();
            };
            req.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

async function dbDeleteAllByChar(charId) {
    if (!charId) return;
    const db = await initDB();
    const items = await dbGetIllustrations(charId);
    for (const it of items) await dbClearThumbnailsForRule(it.id);

    return new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const it of items) store.delete(it.id);
            tx.oncomplete = () => {
                invalidateCache();
                cachedStorageStats = null;
                resolve();
            };
            tx.onerror = (e) => reject(e);
        } catch (err) {
            dbInstance = null;
            reject(err);
        }
    });
}

async function dbOptimizeCurrentChar(charId, onProgress) {
    const items = await dbGetIllustrations(charId);
    if (!items.length) {
        return { totalRules: 0, savedDuplicates: 0, oldBytes: 0, newBytes: 0, optimizedCount: 0, skippedCount: 0 };
    }
    const db = await initDB();
    const unoptimizedItems = items.filter(it => !it.optimized);
    if (unoptimizedItems.length === 0) {
        return { totalRules: items.length, savedDuplicates: 0, oldBytes: 0, newBytes: 0, optimizedCount: 0, skippedCount: items.length };
    }

    const blobRegistry = new Map();
    for (const item of items) {
        if (item.optimized && Array.isArray(item.images)) {
            for (const img of item.images) {
                if (img instanceof Blob) {
                    const fp = await getBlobFingerprint(img);
                    if (fp && !blobRegistry.has(fp)) blobRegistry.set(fp, img);
                }
            }
        }
    }

    const optimizedItems = [];
    let savedDuplicates = 0;
    const totalImagesToProcess = unoptimizedItems.reduce((acc, it) => acc + (it.images?.length || 1), 0);
    let processedImages = 0;
    let totalOldBytes = 0, totalNewBytes = 0, newlyOptimizedCount = 0, skippedCount = 0;

    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item.optimized) {
            skippedCount++;
            optimizedItems.push({ ...item, order: index + 1 });
            continue;
        }

        const rawImgs = item.images || (item.data ? [item.data] : []);
        if (!rawImgs.length) continue;

        const deduplicatedBlobs = [];
        for (const rawImg of rawImgs) {
            processedImages++;
            if (onProgress) onProgress(processedImages, totalImagesToProcess, `正在处理未优化插图 (${processedImages}/${totalImagesToProcess})...`);

            const blob = (typeof rawImg === 'string' && rawImg.startsWith('data:image')) ? base64ToBlob(rawImg) : rawImg;
            if (blob instanceof Blob) {
                totalOldBytes += blob.size;
                const compressedBlob = await compressImageLossless(blob, 0.985);
                totalNewBytes += compressedBlob.size;

                const fp = await getBlobFingerprint(compressedBlob);
                if (fp) {
                    if (blobRegistry.has(fp)) {
                        deduplicatedBlobs.push(blobRegistry.get(fp));
                        savedDuplicates++;
                    } else {
                        blobRegistry.set(fp, compressedBlob);
                        deduplicatedBlobs.push(compressedBlob);
                    }
                } else {
                    deduplicatedBlobs.push(compressedBlob);
                }
            } else {
                deduplicatedBlobs.push(blob);
            }
            await new Promise(r => setTimeout(r, 0));
        }

        const cleanRules = cleanAndNormalizeRules(item.rules || item.keywords);
        if (!cleanRules.length) continue;

        const cleanNames = Array.isArray(item.imageNames) ? [...item.imageNames] : [];
        while (cleanNames.length < deduplicatedBlobs.length) cleanNames.push('');
        if (cleanNames.length > deduplicatedBlobs.length) cleanNames.length = deduplicatedBlobs.length;

        let selectedIdx = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;
        if (selectedIdx < 0 || selectedIdx >= deduplicatedBlobs.length) selectedIdx = 0;

        optimizedItems.push({
            id: item.id,
            charId: item.charId,
            rules: cleanRules,
            images: deduplicatedBlobs,
            imageNames: cleanNames,
            selectedIndex: selectedIdx,
            groupName: typeof item.groupName === 'string' ? item.groupName.trim() : '',
            order: index + 1,
            optimized: true,
            optimizedAt: Date.now(),
            createdAt: item.createdAt || Date.now()
        });
        newlyOptimizedCount++;
    }

    await new Promise((resolve, reject) => {
        try {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            for (const rec of optimizedItems) store.put(rec);
            tx.oncomplete = () => resolve();
            tx.onerror = (e) => reject(e);
        } catch (err) {
            reject(err);
        }
    });

    const activeRuleIds = new Set(optimizedItems.map(i => i.id));
    await new Promise((resolve) => {
        try {
            const tx = db.transaction([THUMB_STORE_NAME], 'readwrite');
            const req = tx.objectStore(THUMB_STORE_NAME).openCursor();
            req.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    const ruleId = parseInt(String(cursor.key).split('_')[0], 10);
                    if (!isNaN(ruleId) && !activeRuleIds.has(ruleId)) cursor.delete();
                    cursor.continue();
                } else {
                    resolve();
                }
            };
            req.onerror = () => resolve();
        } catch (_) { resolve(); }
    });

    invalidateCache();
    return {
        totalRules: optimizedItems.length,
        savedDuplicates,
        oldBytes: totalOldBytes,
        newBytes: totalNewBytes,
        optimizedCount: newlyOptimizedCount,
        skippedCount
    };
}

// ==================== 5. 状态与配置持久化 ====================
let tempBlobList = [];
let allowUserTrigger = localStorage.getItem('ci_allow_user_msg') === '1';
let showAllMatched = localStorage.getItem('ci_show_all_matched') !== '0';
let singleImageMode = localStorage.getItem('ci_single_image_mode') !== '0';

let rawSavedPos = localStorage.getItem('ci_display_position') || 'top';
if (rawSavedPos === 'horizontal_scroll') rawSavedPos = 'top_scroll';
let displayPosition = rawSavedPos;

let topFixedSize = localStorage.getItem('ci_top_fixed_size') || 'large';
let currentArbitrateController = null;

function getCustomGroups(charId) {
    if (!charId) return [];
    try {
        const raw = localStorage.getItem(`ci_groups_${charId}`);
        return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
}

function saveCustomGroups(charId, groups) {
    if (!charId) return;
    const clean = Array.from(new Set(groups.map(g => String(g).trim()).filter(Boolean)));
    localStorage.setItem(`ci_groups_${charId}`, JSON.stringify(clean));
}

function getFolderCollapsedState(charId, groupKey) {
    return localStorage.getItem(`ci_folder_collapsed_${charId}_${groupKey}`) === '1';
}

function setFolderCollapsedState(charId, groupKey, isCollapsed) {
    localStorage.setItem(`ci_folder_collapsed_${charId}_${groupKey}`, isCollapsed ? '1' : '0');
}

let apiSettings = {
    enabled: localStorage.getItem('ci_api_enabled') === '1',
    url: localStorage.getItem('ci_api_url') || '',
    key: localStorage.getItem('ci_api_key') || '',
    model: localStorage.getItem('ci_api_model') || ''
};

function saveApiSettings() {
    localStorage.setItem('ci_api_enabled', apiSettings.enabled ? '1' : '0');
    localStorage.setItem('ci_api_url', apiSettings.url);
    localStorage.setItem('ci_api_key', apiSettings.key);
    localStorage.setItem('ci_api_model', apiSettings.model);
}

function cleanApiUrl(url) {
    return (url || '').trim().replace(/\/+$/, '');
}

async function fetchModelsList() {
    if (!apiSettings.url) throw new Error('请先输入 API URL');
    const baseUrl = cleanApiUrl(apiSettings.url);
    const targetUrl = baseUrl.endsWith('/models') ? baseUrl : `${baseUrl}/models`;
    const headers = { 'Content-Type': 'application/json' };
    if (apiSettings.key) headers['Authorization'] = `Bearer ${apiSettings.key}`;

    const resp = await fetch(targetUrl, { credentials: 'omit', headers });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const data = await resp.json();
    const list = data.data || data;
    return Array.isArray(list) ? list.map(m => m.id || m.name).filter(Boolean) : [];
}

async function testChatApi() {
    if (!apiSettings.url) throw new Error('请先填写 API URL');
    if (!apiSettings.model) throw new Error('请先选择或输入模型名');

    const baseUrl = cleanApiUrl(apiSettings.url);
    const chatEndpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

    const resp = await fetch(chatEndpoint, {
        method: 'POST',
        credentials: 'omit',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiSettings.key}`
        },
        body: JSON.stringify({
            model: apiSettings.model,
            messages: [{ role: 'user', content: 'Say "OK"' }],
            max_tokens: 10,
            temperature: 0.1
        })
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const res = await resp.json();
    return res.choices?.[0]?.message?.content?.trim() || 'OK';
}

async function arbitrateScenario(fullRawText, candidateItems) {
    if (!apiSettings.enabled || !apiSettings.url || !apiSettings.model) return null;

    if (currentArbitrateController) currentArbitrateController.abort();
    const controller = new AbortController();
    currentArbitrateController = controller;

    const optionsList = candidateItems.map(item => `- 插图: 【${formatRuleDisplay(item)}】`).join('\n');
    const systemPrompt = `你是一个高度精准的二次元剧情插图判定中枢。你接收的内容包含角色的【思维链推演/设定审查(Subtext/Think等隐藏内容)】以及【实际对话与叙述正文】。

你的核心任务：
1. 全文综合感知：结合文本中角色的真实状态推演、设定审查和行动，确定当前场景下“每个角色当下最终生效的形态或服装”。
2. 实体与形态强绑定：绝对不能张冠李戴！
3. 状态时序替换：若角色中途换装或变身，只保留最终定格的形态，屏蔽旧形态。
4. 严格输出格式：必须且仅输出纯 JSON 数组，包含所有符合当前场面的插图数字 ID（例如 [1, 3]；若完全不符合则返回 []）。严禁包含任何分析说明或 Markdown 代码块！`;

    const userPrompt = `【候选插图库】：\n${optionsList}\n\n【包含隐藏推演与正文的完整消息】：\n"""${fullRawText}"""\n\n请输出当前场景下真正应当展示的插图ID数组：`;
    const baseUrl = cleanApiUrl(apiSettings.url);
    const chatEndpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;

    try {
        const resp = await fetch(chatEndpoint, {
            method: 'POST',
            credentials: 'omit',
            signal: controller.signal,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiSettings.key}`
            },
            body: JSON.stringify({
                model: apiSettings.model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                temperature: 0.05
            })
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status} - ${await resp.text()}`);
        const result = await resp.json();
        const rawContent = result.choices?.[0]?.message?.content?.trim() || '';
        const cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
        const jsonMatch = cleanContent.match(/\[[\d\s,]*?\]/);
        if (jsonMatch) {
            try { return JSON.parse(jsonMatch[0].replace(/,\s*\]/, ']')); } catch (_) {}
        }
    } catch (e) {
        if (e.name === 'AbortError') return null;
        toastr?.error?.(`插图AI判定请求失败: ${e.message}`, '插图插件');
    } finally {
        if (currentArbitrateController === controller) currentArbitrateController = null;
    }
    return null;
}

function getCurrentCharId(messageEl = null) {
    const context = getContext();
    if (!context) return null;

    if (messageEl) {
        const chid = messageEl.getAttribute('chid');
        if (chid !== null && context.characters?.[chid]) {
            const char = context.characters[chid];
            return char.avatar || char.name || String(chid);
        }
    }
    if (context.characterId !== undefined && context.characters?.[context.characterId]) {
        const char = context.characters[context.characterId];
        return char.avatar || char.name || String(context.characterId);
    }
    return null;
}

function getCurrentCharDisplayName() {
    const context = getContext();
    return (context?.characterId !== undefined && context?.characters?.[context.characterId]?.name) || '当前角色';
}

function clearOldIllustrations() {
    document.querySelectorAll('.char-illustration-container, #ci-top-fixed-container, .ci-carousel-root').forEach(el => el.remove());
}

function getRawMessageContent(messageEl) {
    try {
        const context = getContext();
        const mesIdAttr = messageEl.getAttribute('mesid');
        if (mesIdAttr !== null && context?.chat) {
            const id = parseInt(mesIdAttr, 10);
            if (!isNaN(id) && typeof context.chat[id]?.mes === 'string') return context.chat[id].mes;
        }
        if (context?.chat?.length > 0) {
            const allMes = Array.from(document.querySelectorAll('#chat .mes'));
            const idx = allMes.indexOf(messageEl);
            if (idx !== -1 && typeof context.chat[idx]?.mes === 'string') return context.chat[idx].mes;
        }
    } catch (_) {}

    const textEl = messageEl.querySelector('.mes_text');
    return textEl ? (textEl.innerText || textEl.textContent || '') : (messageEl.innerText || messageEl.textContent || '');
}

function showGlobalDialog(title, htmlContent, onConfirm) {
    const existing = document.getElementById('ci-custom-dialog');
    if (existing) existing.remove();

    const dialog = document.createElement('div');
    dialog.id = 'ci-custom-dialog';
    dialog.className = 'ci-confirm-modal active';
    dialog.innerHTML = `
        <div class="ci-confirm-content">
            <h3>${escapeHtml(title)}</h3>
            <div>${htmlContent}</div>
            <div class="ci-confirm-actions">
                <button id="ci-dialog-cancel" class="menu_button">取消</button>
                <button id="ci-dialog-confirm" class="menu_button ci-btn-danger">确认执行</button>
            </div>
        </div>
    `;
    document.body.appendChild(dialog);

    const contentBox = dialog.querySelector('.ci-confirm-content');
    if (contentBox) contentBox.onclick = (e) => e.stopPropagation();

    dialog.querySelector('#ci-dialog-cancel').onclick = (e) => { e.stopPropagation(); dialog.remove(); };

    const confirmBtn = dialog.querySelector('#ci-dialog-confirm');
    confirmBtn.onclick = async (e) => {
        e.stopPropagation();
        confirmBtn.disabled = true;
        confirmBtn.innerText = '正在执行...';
        try {
            if (onConfirm) await onConfirm();
        } catch (err) {
            alert(`执行失败: ${err.message || err}`);
        } finally {
            dialog.remove();
        }
    };
}

// ==================== 6. 进度条与错误诊断弹窗 ====================
function createProgressModal(title) {
    const existing = document.getElementById('ci-progress-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ci-progress-modal';
    modal.className = 'ci-progress-modal';
    modal.innerHTML = `
        <div class="ci-progress-dialog">
            <div class="ci-progress-title">${escapeHtml(title)}</div>
            <div class="ci-progress-bar-bg">
                <div class="ci-progress-bar-fill" id="ci-progress-fill"></div>
            </div>
            <div class="ci-progress-info">
                <span id="ci-progress-status">准备就绪...</span>
                <span id="ci-progress-percent">0%</span>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.onclick = (e) => e.stopPropagation();
    requestAnimationFrame(() => modal.classList.add('active'));

    const fillEl = modal.querySelector('#ci-progress-fill');
    const statusEl = modal.querySelector('#ci-progress-status');
    const percentEl = modal.querySelector('#ci-progress-percent');

    return {
        update(current, total, statusText = '') {
            const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
            fillEl.style.width = `${pct}%`;
            percentEl.textContent = `${pct}%`;
            statusEl.textContent = statusText || `正在处理 (${current}/${total})...`;
        },
        close(delay = 400) {
            setTimeout(() => {
                modal.classList.remove('active');
                setTimeout(() => modal.remove(), 200);
            }, delay);
        }
    };
}

function showDetailedErrorReportModal(reportData) {
    const existing = document.getElementById('ci-error-report-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ci-error-report-modal';
    modal.className = 'ci-confirm-modal active';

    const fullReportText = `================ 角色插图配置导入错误报告 ================
时间: ${new Date().toLocaleString()}
错误信息: ${reportData.message || '未知错误'}
文件名称: ${reportData.fileName || '未知'}
文件总大小: ${reportData.fileSize || '0 B'}
已成功导入规则项数: ${reportData.importedCount || 0}
错误堆栈:
${reportData.stack || '无堆栈信息'}
========================================================`;

    modal.innerHTML = `
        <div class="ci-confirm-content" style="max-width: 600px; width: 92%; max-height: 85vh; display: flex; flex-direction: column;">
            <h3 style="color: #ff4d4f; display: flex; align-items: center; justify-content: space-between;">
                <span>❌ 导入失败诊断报告</span>
                <span id="ci-error-close-x" style="cursor: pointer; font-size: 1.2em; color: #bbb;">&times;</span>
            </h3>
            <div style="font-size: 0.88em; color: #eee; line-height: 1.5;">
                <p style="margin: 0 0 6px 0;">解析或写入流时发生异常。原配置已被完好保护未被删除。</p>
            </div>
            <textarea readonly style="flex: 1; min-height: 220px; font-family: monospace; font-size: 0.78em; background: rgba(0,0,0,0.6); color: #ffd166; border: 1px solid rgba(255,255,255,0.2); border-radius: 6px; padding: 8px; resize: none; white-space: pre-wrap; word-break: break-all;">${escapeHtml(fullReportText)}</textarea>
            <div class="ci-confirm-actions" style="margin-top: 10px; display: flex; justify-content: flex-end; gap: 8px;">
                <button id="ci-copy-report-btn" class="menu_button ci-btn-accent" style="background: #2a9d8f !important;">📋 复制完整错误报告</button>
                <button id="ci-error-close-btn" class="menu_button">关闭</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const closeModal = (e) => { if (e) e.stopPropagation(); modal.remove(); };
    modal.querySelector('#ci-error-close-x').onclick = closeModal;
    modal.querySelector('#ci-error-close-btn').onclick = closeModal;

    const copyBtn = modal.querySelector('#ci-copy-report-btn');
    copyBtn.onclick = async (e) => {
        e.stopPropagation();
        const success = await copyTextDirectly(fullReportText);
        if (success) {
            copyBtn.innerText = '已复制到剪贴板 ✓';
            setTimeout(() => { copyBtn.innerText = '📋 复制完整错误报告'; }, 1500);
        } else {
            alert('复制失败，请在文本框内手动全选复制。');
        }
    };
}

async function streamParseAndImportLargeJson(file, charId, onProgress) {
    const reader = file.stream().getReader();
    const decoder = new TextDecoder('utf-8');
    const totalBytes = file.size;
    let loadedBytes = 0, buffer = '', insideIllustrations = false, depth = 0;
    let inString = false, isEscaped = false, currentObjectStart = -1, importedCount = 0, scanIdx = 0, hasWipedOldData = false;
    let batch = [];
    const BATCH_SIZE = 15;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        loadedBytes += value.length;
        buffer += decoder.decode(value, { stream: true });

        if (!insideIllustrations) {
            const arrIndex = buffer.indexOf('"illustrations"');
            if (arrIndex !== -1) {
                const openBracket = buffer.indexOf('[', arrIndex);
                if (openBracket !== -1) {
                    insideIllustrations = true;
                    buffer = buffer.slice(openBracket + 1);
                    scanIdx = 0;
                }
            }
        }

        if (insideIllustrations) {
            while (scanIdx < buffer.length) {
                const char = buffer[scanIdx];
                if (inString) {
                    if (isEscaped) isEscaped = false;
                    else if (char === '\\') isEscaped = true;
                    else if (char === '"') inString = false;
                    scanIdx++;
                    continue;
                }
                if (char === '"') { inString = true; scanIdx++; continue; }
                if (char === '{') {
                    if (depth === 0) currentObjectStart = scanIdx;
                    depth++;
                } else if (char === '}') {
                    depth--;
                    if (depth === 0 && currentObjectStart !== -1) {
                        try {
                            const opt = optimizeIllustrationRecord(JSON.parse(buffer.slice(currentObjectStart, scanIdx + 1)), importedCount + batch.length + 1);
                            if (opt) batch.push(opt);

                            if (batch.length >= BATCH_SIZE) {
                                if (!hasWipedOldData) { await dbDeleteAllByChar(charId); hasWipedOldData = true; }
                                importedCount += await dbBatchInsertItems(charId, batch);
                                batch = [];
                                if (onProgress) {
                                    onProgress(loadedBytes, totalBytes, `导入中 (${(loadedBytes / 1048576).toFixed(1)}MB / ${(totalBytes / 1048576).toFixed(1)}MB) · 已写入 ${importedCount} 条`);
                                }
                            }
                        } catch (_) {}
                        buffer = buffer.slice(scanIdx + 1);
                        scanIdx = 0;
                        currentObjectStart = -1;
                        await new Promise(r => setTimeout(r, 0));
                        continue;
                    }
                } else if (char === ']' && depth === 0) {
                    insideIllustrations = false;
                    break;
                }
                scanIdx++;
            }
        }
    }

    if (batch.length > 0) {
        if (!hasWipedOldData) await dbDeleteAllByChar(charId);
        importedCount += await dbBatchInsertItems(charId, batch);
    }

    invalidateCache();
    cachedStorageStats = null;
    return importedCount;
}

// ==================== 7. 更换插图选择模态窗 ====================
function openImagePickerModal(item, onSelect) {
    const existingModal = document.getElementById('ci-picker-modal');
    if (existingModal) existingModal.remove();

    const pickerModal = document.createElement('div');
    pickerModal.id = 'ci-picker-modal';
    pickerModal.className = 'ci-picker-modal';

    const imgs = item.images || [];
    const names = item.imageNames || [];
    const currentSelected = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;

    pickerModal.innerHTML = `
        <div class="ci-picker-backdrop"></div>
        <div class="ci-picker-dialog">
            <div class="ci-picker-header">
                <div class="ci-picker-title">✨ 选择并锁定要展示的插图</div>
                <div class="ci-picker-close">×</div>
            </div>
            <div class="ci-picker-hint">点击下方插图即可更换。选择后今后触发该规则将<b>固定展示</b>此图：</div>
            <div class="ci-picker-grid">
                ${imgs.map((rawSource, idx) => {
                    const displayName = names[idx]?.trim() || `插图 ${idx + 1}`;
                    const isActive = idx === currentSelected;
                    return `
                        <div class="ci-picker-card ${isActive ? 'active' : ''}" data-idx="${idx}">
                            <div class="ci-picker-img-box">
                                <img class="ci-picker-preview-img" data-idx="${idx}" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'></svg>" loading="lazy" decoding="async" alt="${escapeHtml(displayName)}" />
                                ${isActive ? '<div class="ci-picker-badge">当前已选</div>' : ''}
                            </div>
                            <div class="ci-picker-name" title="${escapeHtml(displayName)}">${escapeHtml(displayName)}</div>
                        </div>
                    `;
                }).join('')}
            </div>
        </div>
    `;
    document.body.appendChild(pickerModal);

    pickerModal.querySelectorAll('.ci-picker-preview-img').forEach(imgEl => {
        const rawSource = imgs[parseInt(imgEl.dataset.idx, 10)];
        if (rawSource) {
            urlManager.getManageThumbnailUrl(rawSource, 260, 0.7).then(thumbUrl => {
                if (imgEl && thumbUrl) imgEl.src = thumbUrl;
            });
        }
    });

    const dialog = pickerModal.querySelector('.ci-picker-dialog');
    if (dialog) dialog.onclick = (e) => e.stopPropagation();

    const closePicker = (e) => {
        if (e) e.stopPropagation();
        pickerModal.classList.remove('active');
        setTimeout(() => pickerModal.remove(), 180);
    };

    pickerModal.querySelector('.ci-picker-backdrop').onclick = closePicker;
    pickerModal.querySelector('.ci-picker-close').onclick = closePicker;

    pickerModal.querySelectorAll('.ci-picker-card').forEach(card => {
        card.onclick = (e) => {
            e.stopPropagation();
            const chosenIdx = parseInt(card.dataset.idx, 10);
            closePicker();
            if (onSelect) onSelect(chosenIdx);
        };
    });
    requestAnimationFrame(() => pickerModal.classList.add('active'));
}

// ==================== 8. 单规则多图管理弹窗 ====================
function openManageImagesModal(item, onUpdated) {
    const existing = document.getElementById('ci-manage-modal');
    if (existing) existing.remove();

    const manageModal = document.createElement('div');
    manageModal.id = 'ci-manage-modal';
    manageModal.className = 'ci-manage-modal';

    let localImgs = [...(item.images || [])];
    let localNames = [...(item.imageNames || [])];
    while (localNames.length < localImgs.length) localNames.push('');
    let localSelectedIndex = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;
    if (localSelectedIndex >= localImgs.length) localSelectedIndex = 0;

    function syncInputsToLocalNames() {
        const container = manageModal.querySelector('#ci-manage-grid-container');
        if (!container) return;
        container.querySelectorAll('.ci-manage-name-input').forEach(inp => {
            const idx = parseInt(inp.dataset.idx, 10);
            if (!isNaN(idx) && idx < localNames.length) localNames[idx] = inp.value;
        });
    }

    function renderGridContent() {
        return localImgs.map((rawSource, idx) => {
            const isSelected = idx === localSelectedIndex;
            const nameVal = localNames[idx] || '';
            return `
                <div class="ci-manage-item ${isSelected ? 'is-selected' : ''}" data-idx="${idx}">
                    <div class="ci-manage-img-wrap">
                        <div class="ci-manage-order-bar">
                            <button type="button" class="ci-order-mini-btn ci-suborder-left" data-idx="${idx}" title="向前调整顺序" ${idx === 0 ? 'disabled' : ''}>◀</button>
                            <span class="ci-img-index-badge">#${idx + 1}</span>
                            <button type="button" class="ci-order-mini-btn ci-suborder-right" data-idx="${idx}" title="向后调整顺序" ${idx === localImgs.length - 1 ? 'disabled' : ''}>▶</button>
                        </div>
                        <img class="ci-manage-preview-img" data-idx="${idx}" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='130' height='130'></svg>" loading="lazy" decoding="async" title="点击放大预览" />
                    </div>
                    <input class="ci-manage-name-input" data-idx="${idx}" type="text" placeholder="输入插图命名..." value="${escapeHtml(nameVal)}" title="输入给这张插图的文字名称" />
                    <div class="ci-manage-actions">
                        <button type="button" class="ci-set-default-btn" data-idx="${idx}">${isSelected ? '★ 默认展示' : '设为默认'}</button>
                        <span class="ci-manage-del-btn" data-idx="${idx}" title="从该规则中移除此图">🗑️</span>
                    </div>
                </div>
            `;
        }).join('');
    }

    manageModal.innerHTML = `
        <div class="ci-manage-backdrop"></div>
        <div class="ci-manage-dialog">
            <div class="ci-manage-header">
                <div>🖼️ 插图与命名管理</div>
                <div class="ci-manage-close" style="cursor:pointer; font-size:1.4em; line-height:1;">×</div>
            </div>
            <div style="font-size:0.82em; color:#bbb;">可点击 <b>◀ / ▶</b> 调整排版顺序，输入命名并在聊天中随时自选切换：</div>
            <div class="ci-manage-grid" id="ci-manage-grid-container">
                ${renderGridContent()}
            </div>
            <div class="ci-manage-footer">
                <button type="button" id="ci-modal-append-btn" class="menu_button ci-mini-btn" style="background:#457b9d; color:#fff;">＋ 追加新插图</button>
                <div style="display:flex; gap:8px;">
                    <button type="button" id="ci-modal-cancel-btn" class="menu_button ci-mini-btn">取消</button>
                    <button type="button" id="ci-modal-save-btn" class="menu_button ci-mini-btn ci-btn-accent">保存修改</button>
                </div>
            </div>
            <input id="ci-modal-file-input" type="file" accept="image/*" multiple style="display:none;" />
        </div>
    `;
    document.body.appendChild(manageModal);

    const dialog = manageModal.querySelector('.ci-manage-dialog');
    if (dialog) dialog.onclick = (e) => e.stopPropagation();

    const closeManageModal = (e) => {
        if (e) e.stopPropagation();
        manageModal.classList.remove('active');
        setTimeout(() => manageModal.remove(), 180);
    };

    function bindGridEvents() {
        const container = manageModal.querySelector('#ci-manage-grid-container');
        container.innerHTML = renderGridContent();

        container.querySelectorAll('.ci-manage-preview-img').forEach(imgEl => {
            const rawSource = localImgs[parseInt(imgEl.dataset.idx, 10)];
            if (rawSource) {
                urlManager.getManageThumbnailUrl(rawSource, 260, 0.7).then(thumbUrl => {
                    if (imgEl && thumbUrl) imgEl.src = thumbUrl;
                });
                imgEl.onclick = (e) => { e.stopPropagation(); window.openCIModal(toDisplayUrl(rawSource)); };
            }
        });

        container.querySelectorAll('.ci-manage-name-input').forEach(inp => {
            inp.addEventListener('click', (e) => e.stopPropagation());
            inp.addEventListener('focus', (e) => e.stopPropagation());
            inp.oninput = (e) => {
                e.stopPropagation();
                localNames[parseInt(e.target.dataset.idx, 10)] = e.target.value;
            };
        });

        container.querySelectorAll('.ci-set-default-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                syncInputsToLocalNames();
                localSelectedIndex = parseInt(btn.dataset.idx, 10);
                bindGridEvents();
            };
        });

        const swapItem = (i1, i2) => {
            syncInputsToLocalNames();
            [localImgs[i1], localImgs[i2]] = [localImgs[i2], localImgs[i1]];
            [localNames[i1], localNames[i2]] = [localNames[i2], localNames[i1]];
            if (localSelectedIndex === i1) localSelectedIndex = i2;
            else if (localSelectedIndex === i2) localSelectedIndex = i1;
            bindGridEvents();
        };

        container.querySelectorAll('.ci-suborder-left').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                if (idx > 0) swapItem(idx, idx - 1);
            };
        });

        container.querySelectorAll('.ci-suborder-right').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                if (idx < localImgs.length - 1) swapItem(idx, idx + 1);
            };
        });

        container.querySelectorAll('.ci-manage-del-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.stopPropagation();
                syncInputsToLocalNames();
                const idx = parseInt(btn.dataset.idx, 10);
                if (localImgs.length <= 1) return alert('每条规则至少需要保留 1 张插图！如不再需要此规则，请在主面板中点击“删除”。');
                if (confirm(`确认移除第 ${idx + 1} 张图片吗？`)) {
                    localImgs.splice(idx, 1);
                    localNames.splice(idx, 1);
                    if (localSelectedIndex >= localImgs.length) localSelectedIndex = 0;
                    bindGridEvents();
                }
            };
        });
    }

    bindGridEvents();
    manageModal.querySelector('.ci-manage-backdrop').onclick = closeManageModal;
    manageModal.querySelector('.ci-manage-close').onclick = closeManageModal;
    manageModal.querySelector('#ci-modal-cancel-btn').onclick = closeManageModal;

    const modalFileInput = manageModal.querySelector('#ci-modal-file-input');
    manageModal.querySelector('#ci-modal-append-btn').onclick = (e) => {
        e.stopPropagation();
        syncInputsToLocalNames();
        modalFileInput.value = '';
        modalFileInput.click();
    };

    modalFileInput.onchange = (e) => {
        e.stopPropagation();
        const files = Array.from(e.target.files);
        if (!files.length) return;
        for (const file of files) { localImgs.push(file); localNames.push(''); }
        bindGridEvents();
    };

    const saveBtn = manageModal.querySelector('#ci-modal-save-btn');
    saveBtn.onclick = async (e) => {
        e.stopPropagation();
        saveBtn.innerText = '保存中...';
        saveBtn.disabled = true;
        try {
            syncInputsToLocalNames();
            await dbUpdateIllustration(item.id, null, null, localImgs, localNames, localSelectedIndex);
            closeManageModal();
            if (onUpdated) await onUpdated();
            toastr?.success?.('插图与命名修改已成功保存！', '插图插件');
        } catch (err) {
            alert(`保存失败: ${err.message}`);
            saveBtn.innerText = '保存修改';
            saveBtn.disabled = false;
        }
    };
    requestAnimationFrame(() => manageModal.classList.add('active'));
}

// ==================== 9. 分组维护管理与移动分组弹窗 ====================
function openGroupsManageDialog(charId, onUpdated) {
    const existing = document.getElementById('ci-group-manage-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'ci-group-manage-modal';
    modal.className = 'ci-confirm-modal active';
    modal.innerHTML = `
        <div class="ci-confirm-content" style="border-color:#48cae4 !important; max-width:480px;">
            <h3 style="color:#48cae4 !important; display:flex; justify-content:space-between; align-items:center;">
                <span>🏷️ 分组管理</span>
                <span id="ci-group-close-x" style="cursor:pointer; font-size:1.2em; color:#bbb;">&times;</span>
            </h3>
            <div style="font-size:0.84em; color:#bbb;">仅提供分类归纳功能。可在下方新建、修改分组名称或删除无用分组：</div>
            <div style="display:flex; gap:6px;">
                <input id="ci-new-group-name-input" class="text_pole" type="text" placeholder="输入新分组名称..." style="flex:1;" />
                <button type="button" id="ci-add-group-btn" class="menu_button ci-mini-btn ci-btn-accent">＋ 新建分组</button>
            </div>
            <div class="ci-group-manage-list" id="ci-group-manage-items"></div>
            <div class="ci-confirm-actions">
                <button type="button" id="ci-group-done-btn" class="menu_button ci-mini-btn" style="background:#2a9d8f; color:#fff;">完成</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    const listContainer = modal.querySelector('#ci-group-manage-items');

    function renderGroupList() {
        const curGroups = getCustomGroups(charId);
        if (curGroups.length === 0) {
            listContainer.innerHTML = `<div style="font-size:0.82em; color:#888; text-align:center; padding:10px;">暂无自定义分组</div>`;
            return;
        }
        listContainer.innerHTML = curGroups.map((g, idx) => `
            <div class="ci-group-manage-row">
                <input class="ci-group-manage-input text_pole" data-idx="${idx}" type="text" value="${escapeHtml(g)}" />
                <button type="button" class="menu_button ci-mini-btn ci-btn-danger ci-del-group-btn" data-name="${escapeHtml(g)}">删除</button>
            </div>
        `).join('');

        listContainer.querySelectorAll('.ci-group-manage-input').forEach(inp => {
            inp.addEventListener('click', (e) => e.stopPropagation());
            inp.addEventListener('focus', (e) => e.stopPropagation());
            inp.onchange = async (e) => {
                e.stopPropagation();
                const idx = parseInt(inp.dataset.idx, 10);
                const newVal = e.target.value.trim();
                const cur = getCustomGroups(charId);
                const oldVal = cur[idx];

                if (!newVal || newVal === oldVal) return;
                if (cur.includes(newVal)) {
                    alert('已存在同名分组！');
                    e.target.value = oldVal;
                    return;
                }
                cur[idx] = newVal;
                saveCustomGroups(charId, cur);

                const items = await dbGetIllustrations(charId);
                const affected = items.filter(i => i.groupName === oldVal);
                if (affected.length > 0) {
                    await dbBatchSaveAll(affected.map(i => ({ id: i.id, groupName: newVal })));
                }
                renderGroupList();
                if (onUpdated) await onUpdated();
            };
        });

        listContainer.querySelectorAll('.ci-del-group-btn').forEach(btn => {
            btn.onclick = async (e) => {
                e.stopPropagation();
                const gName = btn.dataset.name;
                if (confirm(`确认删除分组【${gName}】吗？该分组下的插图将被移至“未分组”。`)) {
                    saveCustomGroups(charId, getCustomGroups(charId).filter(g => g !== gName));
                    const items = await dbGetIllustrations(charId);
                    const affected = items.filter(i => i.groupName === gName);
                    if (affected.length > 0) {
                        await dbBatchSaveAll(affected.map(i => ({ id: i.id, groupName: '' })));
                    }
                    renderGroupList();
                    if (onUpdated) await onUpdated();
                }
            };
        });
    }

    renderGroupList();

    const addBtn = modal.querySelector('#ci-add-group-btn');
    const newInp = modal.querySelector('#ci-new-group-name-input');
    newInp.addEventListener('click', (e) => e.stopPropagation());
    newInp.addEventListener('focus', (e) => e.stopPropagation());
    newInp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') addBtn.click();
    });

    addBtn.onclick = async (e) => {
        e.stopPropagation();
        const val = newInp.value.trim();
        if (!val) return;
        const cur = getCustomGroups(charId);
        if (cur.includes(val)) return alert('已存在同名分组！');
        cur.push(val);
        saveCustomGroups(charId, cur);
        newInp.value = '';
        renderGroupList();
        if (onUpdated) await onUpdated();
    };

    const closeModal = async (e) => {
        if (e) e.stopPropagation();
        modal.remove();
        if (onUpdated) await onUpdated();
    };
    modal.querySelector('#ci-group-close-x').onclick = closeModal;
    modal.querySelector('#ci-group-done-btn').onclick = closeModal;
}

function openMoveGroupDialog(charId, item, onUpdated) {
    const existing = document.getElementById('ci-move-dialog-modal');
    if (existing) existing.remove();

    const groups = getCustomGroups(charId);
    const curGroup = item.groupName || '';

    const modal = document.createElement('div');
    modal.id = 'ci-move-dialog-modal';
    modal.className = 'ci-confirm-modal active';
    modal.innerHTML = `
        <div class="ci-confirm-content" style="border-color:#48cae4 !important; max-width:380px;">
            <h3 style="color:#48cae4 !important; font-size:1.05em;">🏷️ 移动至分组</h3>
            <div style="font-size:0.84em; color:#bbb;">选择将该插图规则归入的分组：</div>
            <div style="display:flex; flex-direction:column; gap:8px; max-height:220px; overflow-y:auto; padding:4px 0;">
                <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.9em; padding:6px 8px; border-radius:6px; background:rgba(255,255,255,0.05);">
                    <input type="radio" name="ci-group-choice" value="" ${!curGroup ? 'checked' : ''} />
                    <span><i>[未分组]</i></span>
                </label>
                ${groups.map(g => `
                    <label style="display:flex; align-items:center; gap:8px; cursor:pointer; font-size:0.9em; padding:6px 8px; border-radius:6px; background:rgba(255,255,255,0.05);">
                        <input type="radio" name="ci-group-choice" value="${escapeHtml(g)}" ${curGroup === g ? 'checked' : ''} />
                        <span style="color:#ffd166; font-weight:500;">${escapeHtml(g)}</span>
                    </label>
                `).join('')}
            </div>
            <div class="ci-confirm-actions">
                <button type="button" id="ci-move-cancel-btn" class="menu_button ci-mini-btn">取消</button>
                <button type="button" id="ci-move-save-btn" class="menu_button ci-mini-btn ci-btn-accent">确定移动</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#ci-move-cancel-btn').onclick = (e) => { e.stopPropagation(); modal.remove(); };
    modal.querySelector('#ci-move-save-btn').onclick = async (e) => {
        e.stopPropagation();
        const checked = modal.querySelector('input[name="ci-group-choice"]:checked');
        await dbUpdateIllustration(item.id, null, null, null, null, null, checked ? checked.value : '');
        modal.remove();
        if (onUpdated) await onUpdated();
    };
}

// ==================== 10. 设置主面板渲染 ====================
let thumbObserver = null;

function setupLazyThumbnails(container, items) {
    if (thumbObserver) thumbObserver.disconnect();
    const itemsMap = new Map();
    items.forEach(i => itemsMap.set(i.id, i));

    thumbObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const imgEl = entry.target;
                observer.unobserve(imgEl);
                const item = itemsMap.get(parseInt(imgEl.dataset.id, 10));
                if (!item) return;

                const imgs = item.images || [];
                const selectedIdx = typeof item.selectedIndex === 'number' && item.selectedIndex < imgs.length ? item.selectedIndex : 0;
                const rawSource = imgs[selectedIdx] || imgs[0] || null;
                if (!rawSource) return;

                imgEl.onclick = (e) => { e.stopPropagation(); window.openCIModal(toDisplayUrl(rawSource)); };
                urlManager.getThumbnailUrl(item.id, selectedIdx, rawSource, 180).then(thumbUrl => {
                    if (imgEl && thumbUrl) imgEl.src = thumbUrl;
                });
            }
        });
    }, { root: container.querySelector('.ci-items-list'), rootMargin: '100px' });

    container.querySelectorAll('.ci-thumb-main').forEach(img => thumbObserver.observe(img));
}

function renderSingleCardHtml(item, index, totalInGroup) {
    const imgs = item.images || [];
    const selectedIdx = typeof item.selectedIndex === 'number' && item.selectedIndex < imgs.length ? item.selectedIndex : 0;
    const currentName = (item.imageNames || [])[selectedIdx] || '';
    const groupBadge = item.groupName ? `<span class="ci-group-badge-tag">${escapeHtml(item.groupName)}</span>` : '';
    const optBadge = item.optimized 
        ? `<span style="font-size:0.7em; color:#51cf66; background:rgba(81,207,102,0.15); border:1px solid rgba(81,207,102,0.3); border-radius:3px; padding:1px 5px; white-space:nowrap; display:inline-block; line-height:1.2;">✓ 已优化</span>`
        : `<span style="font-size:0.7em; color:#ffd166; background:rgba(255,209,102,0.15); border:1px solid rgba(255,209,102,0.3); border-radius:3px; padding:1px 5px; white-space:nowrap; display:inline-block; line-height:1.2;">待优化</span>`;

    return `
    <div class="ci-card" data-id="${item.id}">
        <div class="ci-thumb-box">
            <div class="ci-thumb-preview-wrap" data-id="${item.id}" title="点击放大主图 (共 ${imgs.length} 张图片)">
                <img class="ci-thumb-main" data-id="${item.id}" src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='58' height='58'></svg>" alt="缩略图" loading="lazy" decoding="async" />
                <div class="ci-thumb-count-tag">${imgs.length} 图</div>
            </div>
            <div class="ci-order-controls">
                <button type="button" class="ci-order-btn ci-order-up" data-id="${item.id}" title="上移" ${index === 0 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>▲</button>
                <button type="button" class="ci-order-btn ci-order-down" data-id="${item.id}" title="下移" ${index === totalInGroup - 1 ? 'disabled style="opacity:0.3;cursor:not-allowed;"' : ''}>▼</button>
            </div>
        </div>
        <div class="ci-card-info">
            <div class="ci-card-header-row">
                <div style="display:flex; align-items:center; gap:6px; overflow:hidden;">
                    ${optBadge}
                    ${groupBadge}
                    <span style="font-size:0.8em; opacity:0.85; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
                        锁定: <b style="color:#ffd166;">${escapeHtml(currentName || `插图 ${selectedIdx + 1}`)}</b>
                    </span>
                </div>
                <button type="button" class="ci-manage-btn" data-id="${item.id}">🖼️ 管理与命名 (${imgs.length})</button>
            </div>
            <input class="text_pole ci-edit-input" data-id="${item.id}" type="text" value="${escapeHtml(formatRuleDisplay(item))}" placeholder="如: 少女A + 女仆装" />
            <div class="ci-card-actions">
                <button type="button" class="ci-move-group-btn" data-id="${item.id}" title="调整归属分组">🏷️ 移动分组</button>
                <button type="button" class="ci-save-edit-btn" data-id="${item.id}">保存规则</button>
                <button type="button" class="ci-del-btn" data-id="${item.id}">删除</button>
            </div>
        </div>
    </div>
    `;
}

async function renderSettings(forceRefreshStats = false) {
    const container = document.getElementById('ci-settings-content');
    if (!container) return;

    const charId = getCurrentCharId();
    const charName = getCurrentCharDisplayName();

    if (!charId) {
        container.innerHTML = `<div style="opacity:0.7; font-size:0.9em; padding:10px;">请先打开一个角色对话。</div>`;
        return;
    }

    const items = await dbGetIllustrations(charId);
    if (forceRefreshStats || !cachedStorageStats || lastStatsCharId !== charId) {
        cachedStorageStats = await dbGetStorageStats(charId);
        lastStatsCharId = charId;
    }
    const stats = cachedStorageStats || { charSize: '计算中...', totalSize: '计算中...' };
    const customGroups = getCustomGroups(charId);

    const filteredItems = items.filter(item => {
        if (activeGroupFilter === '__UNGROUPED__' && item.groupName) return false;
        if (activeGroupFilter && activeGroupFilter !== '__UNGROUPED__' && item.groupName !== activeGroupFilter) return false;
        if (!searchFilterKeyword.trim()) return true;

        const kw = searchFilterKeyword.trim().toLowerCase();
        return formatRuleDisplay(item).toLowerCase().includes(kw) ||
               (item.groupName || '').toLowerCase().includes(kw) ||
               (item.imageNames || []).join(' ').toLowerCase().includes(kw);
    });

    const allExistingGroups = Array.from(new Set([...customGroups, ...items.map(i => i.groupName).filter(Boolean)]));
    let groupsToDisplay = activeGroupFilter === '__UNGROUPED__'
        ? ['__UNGROUPED__']
        : (activeGroupFilter ? [activeGroupFilter] : [...allExistingGroups]);

    if (!activeGroupFilter && (items.some(i => !i.groupName) || groupsToDisplay.length === 0)) {
        groupsToDisplay.push('__UNGROUPED__');
    }

    const folderBlocksHtml = groupsToDisplay.map(groupKey => {
        const isUngrouped = groupKey === '__UNGROUPED__';
        const groupItems = filteredItems.filter(i => isUngrouped ? !i.groupName : i.groupName === groupKey);
        if (groupItems.length === 0) return '';

        const isCollapsed = getFolderCollapsedState(charId, groupKey);
        const totalImages = groupItems.reduce((acc, cur) => acc + (cur.images?.length || 0), 0);

        return `
            <div class="ci-folder-block ${isCollapsed ? 'collapsed' : ''}" data-group="${escapeHtml(groupKey)}">
                <div class="ci-folder-header" data-group="${escapeHtml(groupKey)}">
                    <div class="ci-folder-title-left">
                        <span class="ci-folder-arrow">▼</span>
                        <span class="ci-folder-name">📁 ${escapeHtml(isUngrouped ? '未分组' : groupKey)}</span>
                        <span class="ci-folder-count-badge">${groupItems.length} 条规则 · 共 ${totalImages} 图</span>
                    </div>
                    <div class="ci-folder-status-tag">${isCollapsed ? '点击展开' : '点击折叠'}</div>
                </div>
                <div class="ci-folder-body">
                    ${groupItems.map((item, idx) => renderSingleCardHtml(item, idx, groupItems.length)).join('')}
                </div>
            </div>
        `;
    }).filter(Boolean).join('');

    container.innerHTML = `
        <div class="ci-panel">
            <div class="ci-api-config-box">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <b>🤖 智能情景过滤 API (AI 仲裁)</b>
                    <label style="display:flex; align-items:center; gap:4px; font-size:0.85em; cursor:pointer;">
                        <input type="checkbox" id="ci-api-enabled" ${apiSettings.enabled ? 'checked' : ''} />
                        <span>启用 AI 过滤</span>
                    </label>
                </div>
                <div id="ci-api-detail-section" style="display: ${apiSettings.enabled ? 'flex' : 'none'}; flex-direction: column; gap: 10px; width: 100%; margin-top: 4px;">
                    <div class="ci-api-row">
                        <label>API URL:</label>
                        <input id="ci-api-url" class="text_pole" type="text" placeholder="https://api.openai.com/v1" value="${escapeHtml(apiSettings.url)}" />
                    </div>
                    <div class="ci-api-row">
                        <label>API KEY:</label>
                        <input id="ci-api-key" class="text_pole" type="password" placeholder="sk-..." value="${escapeHtml(apiSettings.key)}" />
                    </div>
                    <div class="ci-api-row">
                        <label>选择或指定模型名:</label>
                        <div style="display:flex; gap:6px; width:100%;">
                            <input id="ci-api-model" class="text_pole" type="text" placeholder="手动输入或通过右侧选择" value="${escapeHtml(apiSettings.model)}" style="flex:1;" />
                            <select id="ci-api-model-select" class="text_pole" style="display:none; flex:1; max-width: 50%;"></select>
                        </div>
                    </div>
                    <div class="ci-api-btn-group">
                        <button type="button" id="ci-api-fetch-models" class="menu_button ci-btn-standard">1. 连接 / 拉取模型列表</button>
                        <button type="button" id="ci-api-test-chat" class="menu_button ci-btn-standard" style="background:#2a9d8f;">2. 测试 API 对话连通性</button>
                    </div>
                    <div id="ci-api-status-box" class="ci-status-box"></div>
                </div>
            </div>

            <div class="ci-upload-box">
                <b>为角色 [${escapeHtml(charName)}] 添加新规则</b>
                <input id="ci-kw-input" class="text_pole" type="text" placeholder="如: 微笑 + 校园, 礼服" />
                <div class="ci-rule-hint">💡 <b>语法说明：</b>使用 <code>,</code> 分隔备选条件；使用 <code>+</code> 表示必须同时出现。单条规则可绑定多张图。</div>
                <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
                    <button type="button" id="ci-choose-file-btn" class="menu_button">选择本地插图 (可多选)</button>
                    <select id="ci-new-item-group-select" class="text_pole" style="max-width:140px; font-size:0.85em; padding:3px 6px;">
                        <option value="">未分组</option>
                        ${customGroups.map(g => `<option value="${escapeHtml(g)}">${escapeHtml(g)}</option>`).join('')}
                    </select>
                    <button type="button" id="ci-save-btn" class="menu_button" style="background:#2a9d8f;">保存规则与图片</button>
                    <input id="ci-file-input" type="file" accept="image/*" multiple style="display: none;" />
                    <span id="ci-upload-count-hint" style="font-size:0.85em; opacity:0.8; color:#ffd166;"></span>
                </div>
                <div id="ci-preview" class="ci-preview-container" style="display: none;"></div>

                <div style="display:flex; flex-direction:column; gap:6px; font-size:0.85em; margin-top:4px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span><b>插图显示位置：</b></span>
                        <select id="ci-display-pos-select" class="text_pole" style="flex:1; padding:2px 6px; font-size:0.9em;">
                            <option value="top" ${displayPosition === 'top' ? 'selected' : ''}>消息气泡上方 (轮播切换)</option>
                            <option value="top_scroll" ${displayPosition === 'top_scroll' ? 'selected' : ''}>消息气泡上方 (横向无极滑动)</option>
                            <option value="bottom" ${displayPosition === 'bottom' ? 'selected' : ''}>消息气泡下方 (轮播切换)</option>
                            <option value="bottom_scroll" ${displayPosition === 'bottom_scroll' ? 'selected' : ''}>消息气泡下方 (横向无极滑动)</option>
                            <option value="top_fixed" ${displayPosition === 'top_fixed' ? 'selected' : ''}>聊天界面顶部固定 (轮播切换)</option>
                            <option value="top_fixed_scroll" ${displayPosition === 'top_fixed_scroll' ? 'selected' : ''}>聊天界面顶部固定 (横向无极滑动)</option>
                        </select>
                    </div>
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-single-image-mode-chk" ${singleImageMode ? 'checked' : ''} />
                        <span style="color:#ffd166; font-weight:bold;">启用单图展示与自选模式 (单规则仅显示1张插图，可通过“更换”按钮自选并锁定)</span>
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-show-all-chk" ${showAllMatched ? 'checked' : ''} />
                        <span>多个不同规则同时命中时全部展示 (点击按键切换/横向排布; 取消则随机选1个规则)</span>
                    </label>
                    <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
                        <input type="checkbox" id="ci-allow-user-chk" ${allowUserTrigger ? 'checked' : ''} />
                        <span>包含检测用户发出的消息</span>
                    </label>
                </div>
            </div>

            <div class="ci-list-header">
                <div class="ci-list-header-info">
                    <b>已配置规则项 (${items.length})</b>
                    <span style="font-size:0.8em; opacity:0.85;">
                        💾 本角色: <b style="color:#ffd166;">${stats.charSize}</b> | 总库: <b style="color:#2a9d8f;">${stats.totalSize}</b>
                    </span>
                </div>
                <div class="ci-header-actions">
                    <button type="button" id="ci-groups-btn" class="menu_button ci-mini-btn" style="background:#48cae4 !important; color:#111 !important; font-weight:bold;" title="管理与新建自定义分组">🏷️ 分组管理</button>
                    <button type="button" id="ci-refresh-storage-btn" class="menu_button ci-mini-btn" title="刷新存储容量">🔄 刷新</button>
                    <button type="button" id="ci-optimize-btn" class="menu_button ci-mini-btn" style="background:#3a86ff !important; color:#fff;" title="一键视觉原画级无损整理、高保真去重并剔除冗余字段">⚡ 优化库配置</button>
                    <button type="button" id="ci-mark-optimized-btn" class="menu_button ci-mini-btn" style="background:#06d6a0 !important; color:#111 !important; font-weight:bold;" title="直接将全部未优化条目标记为已优化，不再重复压缩">✔ 标为已优化</button>
                    <button type="button" id="ci-save-all-btn" class="menu_button ci-mini-btn ci-btn-accent" title="一键保存所有规则文字">一键保存</button>
                    <button type="button" id="ci-export-btn" class="menu_button ci-mini-btn" title="导出配置">导出</button>
                    <button type="button" id="ci-import-btn" class="menu_button ci-mini-btn" title="导入配置">导入</button>
                    <button type="button" id="ci-delete-all-btn" class="menu_button ci-mini-btn ci-btn-danger" title="清空当前角色插图">清空本角色</button>
                    <button type="button" id="ci-clear-db-btn" class="menu_button ci-mini-btn ci-btn-danger" style="background:#b7094c !important;" title="清空所有角色的插图并释放浏览器空间">🔥 清空整库</button>
                    <input id="ci-import-input" type="file" accept=".json" style="display:none;" />
                </div>
            </div>

            <div class="ci-group-tabs-bar">
                <div class="ci-group-tab-item ${activeGroupFilter === '' ? 'active' : ''}" data-g="">全部 (${items.length})</div>
                <div class="ci-group-tab-item ${activeGroupFilter === '__UNGROUPED__' ? 'active' : ''}" data-g="__UNGROUPED__">未分组 (${items.filter(i => !i.groupName).length})</div>
                ${allExistingGroups.map(g => {
                    const count = items.filter(i => i.groupName === g).length;
                    return count > 0 ? `<div class="ci-group-tab-item ${activeGroupFilter === g ? 'active' : ''}" data-g="${escapeHtml(g)}">${escapeHtml(g)} (${count})</div>` : '';
                }).join('')}
            </div>

            <div class="ci-search-row">
                <div class="ci-search-input-wrapper">
                    <input id="ci-search-kw-input" class="text_pole" type="text" placeholder="输入规则词、分组名称或插图名..." value="${escapeHtml(searchInputValue)}" />
                    ${searchInputValue ? `<button type="button" id="ci-search-clear-btn" class="ci-search-clear" title="清空搜索">×</button>` : ''}
                </div>
                <button type="button" id="ci-search-exec-btn" class="menu_button ci-mini-btn" style="background:#457b9d; color:#fff;">搜索</button>
                ${searchFilterKeyword ? `<button type="button" id="ci-search-reset-btn" class="menu_button ci-mini-btn" title="显示全部">重置</button>` : ''}
            </div>

            <div class="ci-folder-controls-bar">
                <span id="ci-expand-all-folders" class="ci-folder-action-text">📂 展开全部文件夹</span>
                <span style="opacity:0.4; font-size:0.76em;">|</span>
                <span id="ci-collapse-all-folders" class="ci-folder-action-text">📁 折叠全部文件夹</span>
            </div>

            <div class="ci-items-list">
                ${items.length === 0 ? `<div style="font-size:0.85em; opacity:0.6; text-align:center; padding:10px 0;">当前角色暂未配置任何插图</div>` : ''}
                ${items.length > 0 && folderBlocksHtml === '' ? `<div style="font-size:0.85em; opacity:0.6; text-align:center; padding:10px 0;">当前筛选条件下未找到对应插图</div>` : folderBlocksHtml}
            </div>
        </div>
    `;

    setupLazyThumbnails(container, filteredItems);

    container.querySelectorAll('.ci-folder-header').forEach(header => {
        header.onclick = (e) => {
            e.stopPropagation();
            const groupKey = header.dataset.group;
            const block = header.closest('.ci-folder-block');
            const isNowCollapsed = !block.classList.contains('collapsed');
            block.classList.toggle('collapsed', isNowCollapsed);
            header.querySelector('.ci-folder-status-tag').innerText = isNowCollapsed ? '点击展开' : '点击折叠';
            setFolderCollapsedState(charId, groupKey, isNowCollapsed);
        };
    });

    const toggleAllFolders = (collapse) => {
        container.querySelectorAll('.ci-folder-block').forEach(b => {
            b.classList.toggle('collapsed', collapse);
            setFolderCollapsedState(charId, b.dataset.group, collapse);
            const tag = b.querySelector('.ci-folder-status-tag');
            if (tag) tag.innerText = collapse ? '点击展开' : '点击折叠';
        });
    };
    document.getElementById('ci-expand-all-folders')?.addEventListener('click', (e) => { e.stopPropagation(); toggleAllFolders(false); });
    document.getElementById('ci-collapse-all-folders')?.addEventListener('click', (e) => { e.stopPropagation(); toggleAllFolders(true); });

    container.querySelectorAll('.ci-group-tab-item').forEach(tab => {
        tab.onclick = (e) => { e.stopPropagation(); activeGroupFilter = tab.dataset.g; renderSettings(); };
    });

    container.querySelectorAll('.ci-move-group-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const targetItem = items.find(i => i.id === parseInt(btn.dataset.id, 10));
            if (targetItem) openMoveGroupDialog(charId, targetItem, async () => { await renderSettings(); debouncedScan(); });
        };
    });

    document.getElementById('ci-groups-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        openGroupsManageDialog(charId, async () => { await renderSettings(); debouncedScan(); });
    });

    const apiEnabledChk = document.getElementById('ci-api-enabled');
    const apiDetailSection = document.getElementById('ci-api-detail-section');
    const statusBox = document.getElementById('ci-api-status-box');

    function showStatus(text, isError = false) {
        if (!statusBox) return;
        statusBox.style.display = 'block';
        statusBox.style.color = isError ? '#ff6b6b' : '#51cf66';
        statusBox.innerHTML = text;
    }

    apiEnabledChk.onchange = (e) => {
        e.stopPropagation();
        apiSettings.enabled = e.target.checked;
        saveApiSettings();
        if (apiDetailSection) apiDetailSection.style.display = apiSettings.enabled ? 'flex' : 'none';
    };

    const bindApiInput = (id, prop) => {
        document.getElementById(id)?.addEventListener('input', (e) => {
            e.stopPropagation();
            apiSettings[prop] = e.target.value.trim();
            saveApiSettings();
        });
    };
    bindApiInput('ci-api-url', 'url');
    bindApiInput('ci-api-key', 'key');
    bindApiInput('ci-api-model', 'model');

    document.getElementById('ci-api-fetch-models')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        showStatus('⏳ 正在连接端点并获取模型列表...');
        try {
            const models = await fetchModelsList();
            if (!models.length) throw new Error('返回列表为空');
            const apiModelSelect = document.getElementById('ci-api-model-select');
            const apiModelInput = document.getElementById('ci-api-model');
            apiModelSelect.innerHTML = `<option value="">-- 点击选择模型 --</option>` + models.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
            apiModelSelect.style.display = 'block';
            apiModelSelect.value = apiSettings.model;
            apiModelSelect.onchange = (ev) => {
                ev.stopPropagation();
                apiModelInput.value = apiModelSelect.value;
                apiSettings.model = apiModelSelect.value;
                saveApiSettings();
            };
            showStatus(`🟢 <b>连接成功！</b>共读取 <b>${models.length}</b> 个模型。`);
        } catch (err) {
            showStatus(`🔴 <b>拉取失败：</b> ${escapeHtml(err.message)}`, true);
        }
    });

    document.getElementById('ci-api-test-chat')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        showStatus('⏳ 正在发起对话连通性测试...');
        try {
            const reply = await testChatApi();
            showStatus(`🟢 <b>对话测试成功！</b> 模型响应正常 (回复: "${escapeHtml(reply)}")，AI 智能情境过滤已就绪。`);
        } catch (err) {
            showStatus(`🔴 <b>测试失败：</b> 无法与模型对话。<br>错误: ${escapeHtml(err.message)}`, true);
        }
    });

    const fileInput = document.getElementById('ci-file-input');
    const previewContainer = document.getElementById('ci-preview');
    const countHint = document.getElementById('ci-upload-count-hint');

    document.getElementById('ci-display-pos-select')?.addEventListener('change', (e) => {
        e.stopPropagation();
        displayPosition = e.target.value;
        localStorage.setItem('ci_display_position', displayPosition);
        lastScannedText = '';
        clearOldIllustrations();
        scanLatestMessageOnly();
    });

    const bindCheckboxSync = (id, propKey, storageKey, onToggle) => {
        document.getElementById(id)?.addEventListener('change', (e) => {
            e.stopPropagation();
            onToggle(e.target.checked);
            localStorage.setItem(storageKey, e.target.checked ? '1' : '0');
            lastScannedText = '';
            debouncedScan();
        });
    };
    bindCheckboxSync('ci-single-image-mode-chk', 'singleImageMode', 'ci_single_image_mode', v => { singleImageMode = v; });
    bindCheckboxSync('ci-show-all-chk', 'showAllMatched', 'ci_show_all_matched', v => { showAllMatched = v; });
    bindCheckboxSync('ci-allow-user-chk', 'allowUserTrigger', 'ci_allow_user_msg', v => { allowUserTrigger = v; });

    document.getElementById('ci-choose-file-btn')?.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });

    fileInput.onchange = (e) => {
        e.stopPropagation();
        const files = Array.from(e.target.files);
        if (!files.length) return;

        tempBlobList = [...files];
        previewContainer.innerHTML = '';
        for (const file of files) {
            const url = toDisplayUrl(file);
            const thumb = document.createElement('img');
            thumb.src = url;
            thumb.className = 'ci-preview-thumb';
            thumb.decoding = 'async';
            thumb.onclick = (ev) => { ev.stopPropagation(); window.openCIModal(url); };
            previewContainer.appendChild(thumb);
        }
        previewContainer.style.display = 'flex';
        countHint.innerText = `已选 ${files.length} 张图片`;
    };

    document.getElementById('ci-save-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const kwRaw = document.getElementById('ci-kw-input').value.trim();
        if (!kwRaw) return alert('请至少输入一个关键词规则！');
        if (!tempBlobList.length) return alert('请先选择至少一张图片！');

        const rules = parseRuleInput(kwRaw);
        if (!rules.length) return alert('规则解析为空，请重新输入！');

        const chosenGroup = document.getElementById('ci-new-item-group-select')?.value || '';
        await dbAddIllustration(charId, rules, tempBlobList, new Array(tempBlobList.length).fill(''), 0, chosenGroup);
        tempBlobList = [];
        fileInput.value = '';
        countHint.innerText = '';
        renderSettings();
        lastScannedText = '';
        debouncedScan();
    });

    container.querySelectorAll('.ci-manage-btn').forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const targetItem = items.find(i => i.id === parseInt(btn.dataset.id, 10));
            if (targetItem) openManageImagesModal(targetItem, async () => { await renderSettings(); lastScannedText = ''; debouncedScan(); });
        };
    });

    document.getElementById('ci-optimize-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!items.length) return alert('当前角色暂无可优化的配置！');
        const unoptimizedCount = items.filter(it => !it.optimized).length;
        if (unoptimizedCount === 0) return toastr?.info?.('当前角色下所有插图配置均已是最新优化状态，无需重复优化！', '插图插件');

        const progress = createProgressModal(`⚡ 正在增量整理 (${unoptimizedCount} 条待优化)`);
        e.target.disabled = true;
        try {
            const res = await dbOptimizeCurrentChar(charId, (cur, tot, txt) => progress.update(cur, tot, txt));
            urlManager.clearCache();
            progress.update(100, 100, '正在更新存储统计...');
            await renderSettings(true);
            progress.close(500);
            toastr?.success?.(`整理完成！本次新优化 ${res.optimizedCount} 条，跳过已优化 ${res.skippedCount} 条，合并去重 ${res.savedDuplicates} 处数据。`, '插图插件');
        } catch (err) {
            progress.close(0);
            alert(`优化失败: ${err.message || err}`);
        } finally {
            e.target.disabled = false;
        }
    });

    document.getElementById('ci-mark-optimized-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!items.length) return alert('当前角色暂无可操作的条目！');
        const unoptimizedList = items.filter(it => !it.optimized);
        if (unoptimizedList.length === 0) return toastr?.info?.('当前角色的所有条目均已是已优化状态！', '插图插件');

        const btn = e.target;
        btn.disabled = true;
        btn.innerText = '标记中...';
        try {
            const db = await initDB();
            await new Promise((resolve, reject) => {
                const tx = db.transaction([STORE_NAME], 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                for (const it of unoptimizedList) {
                    it.optimized = true;
                    it.optimizedAt = Date.now();
                    store.put(it);
                }
                tx.oncomplete = () => resolve();
                tx.onerror = (err) => reject(err);
            });
            invalidateCache();
            await renderSettings();
            toastr?.success?.(`已将 ${unoptimizedList.length} 条规则一键标记为已优化！`, '插图插件');
        } catch (err) {
            alert(`标记失败: ${err.message || err}`);
        } finally {
            btn.disabled = false;
            btn.innerText = '✔ 标为已优化';
        }
    });

    const searchInput = document.getElementById('ci-search-kw-input');
    const triggerSearch = () => {
        if (searchInput) {
            searchFilterKeyword = searchInput.value.trim();
            renderSettings();
        }
    };
    if (searchInput) {
        searchInput.oninput = (e) => { e.stopPropagation(); searchInputValue = e.target.value; };
        searchInput.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') triggerSearch(); };
    }
    document.getElementById('ci-search-exec-btn')?.addEventListener('click', (e) => { e.stopPropagation(); triggerSearch(); });

    const clearSearch = (e) => {
        e.stopPropagation();
        searchInputValue = '';
        if (searchInput) searchInput.value = '';
        searchFilterKeyword = '';
        renderSettings();
    };
    document.getElementById('ci-search-clear-btn')?.addEventListener('click', clearSearch);
    document.getElementById('ci-search-reset-btn')?.addEventListener('click', clearSearch);

    container.querySelectorAll('.ci-save-edit-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const inputEl = container.querySelector(`.ci-edit-input[data-id="${id}"]`);
            const newVal = inputEl?.value.trim();
            if (!newVal) return alert('规则不能为空！');

            await dbUpdateIllustration(id, parseRuleInput(newVal));
            btn.innerText = '已保存 ✓';
            setTimeout(() => { btn.innerText = '保存规则'; }, 1200);
            lastScannedText = '';
            debouncedScan();
        };
    });

    document.getElementById('ci-save-all-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        const inputs = container.querySelectorAll('.ci-edit-input');
        if (!inputs.length) return alert('当前无规则需要保存！');
        const updates = Array.from(inputs).map(inp => {
            const val = inp.value.trim();
            return val ? { id: parseInt(inp.dataset.id, 10), rules: parseRuleInput(val) } : null;
        }).filter(Boolean);

        if (updates.length > 0) {
            await dbBatchSaveAll(updates);
            e.target.innerText = '全部保存成功 ✓';
            setTimeout(() => { e.target.innerText = '一键保存'; }, 1500);
            lastScannedText = '';
            debouncedScan();
        }
    });

    document.getElementById('ci-refresh-storage-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.target.innerText = '⏳ 统计中';
        await renderSettings(true);
    });

    document.getElementById('ci-clear-db-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        showGlobalDialog(
            '🚨 极度危险：清空整库容量',
            `<p style="margin: 0; line-height: 1.6; font-size: 0.95em;">
                此操作将<b>彻底抹除浏览器 IndexedDB 中存储的所有插图与数据</b>（涵盖所有角色的全部插图配置）！<br>
                <span style="color: #ff3333; font-weight: bold; background: rgba(255, 0, 0, 0.2); padding: 4px 8px; border-radius: 4px; display: inline-block; margin-top: 8px; border: 1px solid rgba(255,0,0,0.4);">
                    ⚠️ 警告：数据一旦清空将永久丢失，绝对无法复原！
                </span>
            </p>`,
            async () => {
                await dbClearEntireDatabase();
                clearOldIllustrations();
                await renderSettings(true);
                lastScannedText = '';
                debouncedScan();
                toastr?.success?.('IndexedDB 数据库已被彻底清空，空间已释放！', '插图插件');
            }
        );
    });

    const shiftItemOrder = async (id, isUp) => {
        const currentItem = items.find(i => i.id === id);
        if (!currentItem) return;
        const groupItems = items.filter(i => (i.groupName || '') === (currentItem.groupName || ''));
        const gIdx = groupItems.findIndex(i => i.id === id);
        const swapTarget = isUp ? groupItems[gIdx - 1] : groupItems[gIdx + 1];
        if (!swapTarget) return;

        const tempOrder = currentItem.order ?? (gIdx + 1);
        currentItem.order = swapTarget.order ?? (isUp ? gIdx : gIdx + 2);
        swapTarget.order = tempOrder;
        await dbBatchSaveAll([
            { id: currentItem.id, order: currentItem.order },
            { id: swapTarget.id, order: swapTarget.order }
        ]);
        renderSettings();
    };

    container.querySelectorAll('.ci-order-up').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); shiftItemOrder(parseInt(btn.dataset.id, 10), true); };
    });
    container.querySelectorAll('.ci-order-down').forEach(btn => {
        btn.onclick = (e) => { e.stopPropagation(); shiftItemOrder(parseInt(btn.dataset.id, 10), false); };
    });

    container.querySelectorAll('.ci-del-btn').forEach(btn => {
        btn.onclick = async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            if (confirm('确认删除该条规则及其绑定的全部插图吗？')) {
                await dbDeleteIllustration(id);
                const remaining = await dbGetIllustrations(charId);
                const activeGroups = new Set(remaining.map(i => i.groupName).filter(Boolean));
                saveCustomGroups(charId, getCustomGroups(charId).filter(g => activeGroups.has(g)));
                renderSettings();
                lastScannedText = '';
                debouncedScan();
            }
        };
    });

    document.getElementById('ci-delete-all-btn')?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (items.length === 0) return alert('当前没有可删除的插图！');
        showGlobalDialog(
            '⚠️ 危险操作确认',
            `<p style="margin: 0; line-height: 1.5; font-size: 0.95em;">
                您确定要<b>一键清空并删除</b>角色【${escapeHtml(charName)}】的所有插图数据及标签分组吗？<br>
                <span style="color: #ff3333; font-weight: bold; margin-top: 6px; display: inline-block;">⚠️ 警告：删除后无法撤销或复原！</span>
            </p>`,
            async () => {
                await dbDeleteAllByChar(charId);
                localStorage.removeItem(`ci_groups_${charId}`);
                clearOldIllustrations();
                await renderSettings(true);
                lastScannedText = '';
                debouncedScan();
            }
        );
    });

    document.getElementById('ci-export-btn')?.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (items.length === 0) return alert('当前角色暂无可导出的配置！');
        const progress = createProgressModal('📦 正在导出插图配置');
        const total = items.length;
        const jsonChunks = [
            `{\n  "version": "3.1",\n  "charName": ${JSON.stringify(charName)},\n  "charId": ${JSON.stringify(charId)},\n  "groups": ${JSON.stringify(customGroups)},\n  "illustrations": [\n`
        ];

        for (let i = 0; i < total; i++) {
            const item = items[i];
            const serializedImgs = [];
            for (const img of (item.images || [])) {
                serializedImgs.push(img instanceof Blob ? await blobToBase64(img) : img);
            }
            const itemRecord = {
                rules: item.rules,
                images: serializedImgs,
                imageNames: item.imageNames || [],
                selectedIndex: typeof item.selectedIndex === 'number' ? item.selectedIndex : 0,
                groupName: item.groupName || '',
                order: item.order,
                optimized: item.optimized === true
            };
            jsonChunks.push(JSON.stringify(itemRecord) + (i < total - 1 ? ',\n' : '\n'));
            progress.update(i + 1, total, `正在打包与序列化 (${i + 1}/${total})`);
            await new Promise(r => setTimeout(r, 0));
        }
        jsonChunks.push('  ]\n}');

        const blob = new Blob(jsonChunks, { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${charName}_插图配置.json`;
        a.click();
        URL.revokeObjectURL(url);
        progress.close(500);
    });

    const importInput = document.getElementById('ci-import-input');
    document.getElementById('ci-import-btn')?.addEventListener('click', (e) => { e.stopPropagation(); importInput.click(); });

    importInput.onchange = async (e) => {
        e.stopPropagation();
        const file = e.target.files[0];
        if (!file) return;

        const progress = createProgressModal('📥 正在导入配置');
        let importedCount = 0;
        try {
            clearOldIllustrations();
            urlManager.clearCache();
            importedCount = await streamParseAndImportLargeJson(file, charId, (l, t, s) => progress.update(l, t, s));
            if (importedCount === 0) throw new Error('未在文件中检测到有效的插图条目，请检查 JSON 格式。');

            const freshItems = await dbGetIllustrations(charId);
            const importedGroups = Array.from(new Set(freshItems.map(i => i.groupName).filter(Boolean)));
            if (importedGroups.length > 0) {
                saveCustomGroups(charId, Array.from(new Set([...getCustomGroups(charId), ...importedGroups])));
            }
            await renderSettings(true);
            lastScannedText = '';
            debouncedScan();
            progress.close(500);
            toastr?.success?.(`已成功导入 ${importedCount} 项规则配置！`, '插图插件');
        } catch (err) {
            progress.close(0);
            showDetailedErrorReportModal({
                message: err.message,
                fileName: file.name,
                fileSize: formatBytes(file.size),
                importedCount,
                stack: err.stack
            });
        } finally {
            importInput.value = '';
        }
    };
}

// ==================== 11. 纯按键轮播与无极左右平滑滚动中枢 ====================
function setupIllustrationCarousel(containerEl, charId) {
    const track = containerEl.querySelector('.ci-carousel-track');
    const prevBtn = containerEl.querySelector('.ci-arrow-prev');
    const nextBtn = containerEl.querySelector('.ci-arrow-next');
    const badgeEl = containerEl.querySelector('.ci-side-badge');
    const dotsContainer = containerEl.querySelector('.ci-carousel-dots');
    if (!track) return;

    let slides = Array.from(track.querySelectorAll('.ci-carousel-slide'));
    if (slides.length === 0) slides = Array.from(track.children);
    const total = slides.length;
    if (total === 0) return;

    const footer = containerEl.querySelector('.ci-carousel-footer');
    if (total <= 1) {
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
        if (badgeEl) badgeEl.style.display = 'none';
        if (footer) footer.style.display = 'none';
        slides[0].classList.add('active');
        if (slides[0]?.dataset?.slideId && charId) activeSlideMemoryByChar.set(charId, slides[0].dataset.slideId);
        updateSideControlsState(slides[0]);
        return;
    } else {
        if (prevBtn) prevBtn.style.display = 'flex';
        if (nextBtn) nextBtn.style.display = 'flex';
        if (badgeEl) badgeEl.style.display = 'block';
        if (footer) footer.style.display = 'flex';
    }

    const rememberedId = activeSlideMemoryByChar.get(charId);
    let activeIndex = 0;
    if (rememberedId) {
        const foundIdx = slides.findIndex(s => s.dataset.slideId === rememberedId);
        if (foundIdx !== -1) activeIndex = foundIdx;
        else activeSlideMemoryByChar.delete(charId);
    }

    if (dotsContainer) {
        dotsContainer.innerHTML = slides.map((_, idx) => `<span class="ci-carousel-dot ${idx === activeIndex ? 'active' : ''}" data-idx="${idx}"></span>`).join('');
        dotsContainer.querySelectorAll('.ci-carousel-dot').forEach(dot => {
            dot.onclick = (e) => { e.stopPropagation(); showSlide(parseInt(dot.dataset.idx, 10)); };
        });
    }

    function updateSideControlsState(slide) {
        const sideSwitchBtn = containerEl.querySelector('.ci-side-switch-btn');
        const sideInfoContainer = containerEl.querySelector('.ci-side-info-container');

        if (sideSwitchBtn) {
            sideSwitchBtn.style.display = (slide && slide._ciOpenPicker) ? 'inline-flex' : 'none';
            sideSwitchBtn.onclick = (slide && slide._ciOpenPicker) ? ((e) => { e.stopPropagation(); slide._ciOpenPicker(); }) : null;
        }

        if (sideInfoContainer) {
            if (slide && slide._ciUpdateSideInfo) {
                slide._ciUpdateSideInfo(sideInfoContainer);
                sideInfoContainer.style.display = 'flex';
            } else {
                sideInfoContainer.style.display = 'none';
            }
        }
    }

    function showSlide(idx) {
        idx = Math.min(Math.max(idx, 0), total - 1);
        activeIndex = idx;

        slides.forEach((slide, i) => slide.classList.toggle('active', i === activeIndex));
        if (prevBtn) prevBtn.disabled = activeIndex <= 0;
        if (nextBtn) nextBtn.disabled = activeIndex >= total - 1;
        if (badgeEl) badgeEl.innerText = `${activeIndex + 1}/${total}`;

        if (dotsContainer) {
            dotsContainer.querySelectorAll('.ci-carousel-dot').forEach((dot, i) => dot.classList.toggle('active', i === activeIndex));
        }

        const currentSlide = slides[activeIndex];
        if (currentSlide?.dataset?.slideId && charId) activeSlideMemoryByChar.set(charId, currentSlide.dataset.slideId);
        updateSideControlsState(currentSlide);
    }

    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); showSlide(activeIndex - 1); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); showSlide(activeIndex + 1); };
    showSlide(activeIndex);
}

function setupHorizontalSmoothScroll(containerEl, charId) {
    const viewport = containerEl.querySelector('.ci-scroll-viewport');
    const track = containerEl.querySelector('.ci-scroll-track');
    const prevBtn = containerEl.querySelector('.ci-arrow-prev');
    const nextBtn = containerEl.querySelector('.ci-arrow-next');
    const badgeEl = containerEl.querySelector('.ci-side-badge');
    const sideSwitchBtn = containerEl.querySelector('.ci-side-switch-btn');
    const sideInfoContainer = containerEl.querySelector('.ci-side-info-container');
    if (!viewport || !track) return;

    const slides = Array.from(track.querySelectorAll('.ci-scroll-slide'));
    const total = slides.length;
    if (total === 0) return;

    let focusedIndex = 0;
    let isTicking = false;
    let isProgrammaticScrolling = false;

    function updateFocusedSlideState(idx) {
        if (idx < 0 || idx >= total) return;
        focusedIndex = idx;

        slides.forEach((s, i) => s.classList.toggle('ci-focused', i === idx));
        if (badgeEl) {
            badgeEl.innerText = `${idx + 1}/${total}`;
            badgeEl.style.display = total > 1 ? 'block' : 'none';
        }
        if (prevBtn) prevBtn.disabled = idx <= 0;
        if (nextBtn) nextBtn.disabled = idx >= total - 1;

        const currentSlide = slides[idx];
        if (currentSlide?.dataset?.slideId && charId) activeSlideMemoryByChar.set(charId, currentSlide.dataset.slideId);

        if (sideSwitchBtn) {
            sideSwitchBtn.style.display = (currentSlide && currentSlide._ciOpenPicker) ? 'inline-flex' : 'none';
            sideSwitchBtn.onclick = (currentSlide && currentSlide._ciOpenPicker) ? ((e) => { e.stopPropagation(); currentSlide._ciOpenPicker(); }) : null;
        }

        if (sideInfoContainer) {
            if (currentSlide && currentSlide._ciUpdateSideInfo) {
                currentSlide._ciUpdateSideInfo(sideInfoContainer);
                sideInfoContainer.style.display = 'flex';
            } else {
                sideInfoContainer.style.display = 'none';
            }
        }
    }

    function detectCenterFocusedSlide() {
        if (isProgrammaticScrolling) return;
        const vRect = viewport.getBoundingClientRect();
        const vCenter = vRect.left + vRect.width / 2;

        let closestIdx = 0, minDistance = Infinity;
        slides.forEach((slide, idx) => {
            const sRect = slide.getBoundingClientRect();
            const dist = Math.abs(vCenter - (sRect.left + sRect.width / 2));
            if (dist < minDistance) {
                minDistance = dist;
                closestIdx = idx;
            }
        });
        if (closestIdx !== focusedIndex) updateFocusedSlideState(closestIdx);
    }

    const onScrollProgress = () => {
        if (!isTicking) {
            requestAnimationFrame(() => { detectCenterFocusedSlide(); isTicking = false; });
            isTicking = true;
        }
    };
    viewport.addEventListener('scroll', onScrollProgress, { passive: true });

    viewport.addEventListener('wheel', (e) => {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.preventDefault();
            viewport.scrollBy({ left: e.deltaY * 1.5, behavior: 'auto' });
            onScrollProgress();
        }
    }, { passive: false });

    // PC 端鼠标拖拽平移支持
    let isMouseDown = false, startX = 0, scrollStartLeft = 0, hasDragged = false;
    viewport.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        isMouseDown = true;
        hasDragged = false;
        startX = e.pageX - viewport.offsetLeft;
        scrollStartLeft = viewport.scrollLeft;
        viewport.classList.add('is-dragging');
    });

    window.addEventListener('mousemove', (e) => {
        if (!isMouseDown) return;
        const walk = (e.pageX - viewport.offsetLeft - startX) * 1.2;
        if (Math.abs(walk) > 4) hasDragged = true;
        viewport.scrollLeft = scrollStartLeft - walk;
    });

    window.addEventListener('mouseup', () => {
        if (isMouseDown) {
            isMouseDown = false;
            viewport.classList.remove('is-dragging');
            detectCenterFocusedSlide();
        }
    });

    slides.forEach(slide => {
        slide.addEventListener('click', (e) => {
            if (hasDragged) { e.stopPropagation(); e.preventDefault(); }
        }, true);
    });

    function scrollToSlide(idx, smooth = true) {
        idx = Math.min(Math.max(idx, 0), total - 1);
        const target = slides[idx];
        if (!target) return;

        isProgrammaticScrolling = true;
        const vRect = viewport.getBoundingClientRect();
        const sRect = target.getBoundingClientRect();
        const delta = (sRect.left + sRect.width / 2) - (vRect.left + vRect.width / 2);

        viewport.scrollBy({ left: delta, behavior: smooth ? 'smooth' : 'auto' });
        updateFocusedSlideState(idx);
        setTimeout(() => { isProgrammaticScrolling = false; }, smooth ? 350 : 50);
    }

    containerEl._ciScrollToSlide = scrollToSlide;
    containerEl._ciGetFocusedIndex = () => focusedIndex;

    containerEl._ciRelockCenter = (targetIdx) => {
        const idx = (typeof targetIdx === 'number' && targetIdx >= 0 && targetIdx < total) ? targetIdx : focusedIndex;
        updateFocusedSlideState(idx);
        let count = 0;
        const intervalId = setInterval(() => {
            count++;
            scrollToSlide(idx, false);
            if (count >= 10) {
                clearInterval(intervalId);
                scrollToSlide(idx, false);
            }
        }, 30);
    };

    if (prevBtn) prevBtn.onclick = (e) => { e.stopPropagation(); scrollToSlide(focusedIndex - 1); };
    if (nextBtn) nextBtn.onclick = (e) => { e.stopPropagation(); scrollToSlide(focusedIndex + 1); };

    const rememberedId = activeSlideMemoryByChar.get(charId);
    let initIdx = 0;
    if (rememberedId) {
        const foundIdx = slides.findIndex(s => s.dataset.slideId === rememberedId);
        if (foundIdx !== -1) initIdx = foundIdx;
        else { activeSlideMemoryByChar.delete(charId); initIdx = 0; }
    }

    const alignInitialPosition = () => {
        requestAnimationFrame(() => {
            scrollToSlide(initIdx, false);
            updateFocusedSlideState(initIdx);
        });
    };
    alignInitialPosition();

    const initImg = slides[initIdx]?.querySelector('img');
    if (initImg) {
        if (initImg.complete) alignInitialPosition();
        else initImg.addEventListener('load', () => alignInitialPosition(), { once: true });
    }
}

// ==================== 12. 消息检测与卡片工厂 ====================
let lastScannedText = '';

function toggleFixedSize(container) {
    topFixedSize = topFixedSize === 'compact' ? 'large' : 'compact';
    const isCompact = topFixedSize === 'compact';
    container.querySelectorAll('.ci-top-fixed-img').forEach(el => el.classList.toggle('ci-compact-size', isCompact));
    container.querySelectorAll('.ci-top-size-toggle-btn').forEach(btn => {
        btn.innerHTML = isCompact ? '⛶' : '⧉';
        btn.title = isCompact ? '切换为大图显示' : '切换为小图显示';
    });
    localStorage.setItem('ci_top_fixed_size', topFixedSize);
}

function buildCardElement({ item, originalSource, subIdx, isHorizontalMode, isTopFixedMode, container, carouselRoot, expandBtn, sideInfoContainer }) {
    const displayUrl = toDisplayUrl(originalSource);
    const card = document.createElement('div');
    card.className = isHorizontalMode 
        ? 'ci-scroll-slide char-illustration-card' 
        : (isTopFixedMode ? 'ci-carousel-slide ci-top-fixed-card' : 'ci-carousel-slide char-illustration-card');
    card.dataset.slideId = subIdx === undefined ? `rule_${item.id}` : `rule_${item.id}_sub_${subIdx}`;

    const innerCard = isTopFixedMode ? document.createElement('div') : card;
    if (isTopFixedMode) innerCard.className = 'ci-top-fixed-inner';

    const img = document.createElement('img');
    img.className = isTopFixedMode ? 'ci-top-fixed-img' : 'char-illustration-img';
    if (isTopFixedMode && topFixedSize === 'compact') img.classList.add('ci-compact-size');

    img.src = displayUrl;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.title = `点击放大查看\n触发规则: ${formatRuleDisplay(item)}`;
    img.onclick = (e) => { e.stopPropagation(); window.openCIModal(displayUrl); };
    img.onerror = () => {
        if (originalSource instanceof Blob) {
            try { img.src = URL.createObjectURL(originalSource); } catch (_) {}
        }
    };
    innerCard.appendChild(img);

    if (!isHorizontalMode) {
        const collapseBtn = document.createElement('div');
        collapseBtn.className = 'char-illustration-collapse-btn';
        collapseBtn.innerHTML = '◀';
        collapseBtn.title = '折叠/隐藏插图';
        collapseBtn.onclick = (e) => { e.stopPropagation(); carouselRoot.classList.add('ci-collapsed'); };
        expandBtn.onclick = (e) => { e.stopPropagation(); carouselRoot.classList.remove('ci-collapsed'); };
        innerCard.appendChild(collapseBtn);

        if (isTopFixedMode) {
            const sizeToggleBtn = document.createElement('div');
            sizeToggleBtn.className = 'ci-top-size-toggle-btn';
            sizeToggleBtn.innerHTML = topFixedSize === 'compact' ? '⛶' : '⧉';
            sizeToggleBtn.title = topFixedSize === 'compact' ? '切换为大图显示' : '切换为小图显示';
            sizeToggleBtn.onclick = (e) => { e.stopPropagation(); toggleFixedSize(container); };
            innerCard.appendChild(sizeToggleBtn);
        }
    }

    card._ciUpdateSideInfo = (infoContainer) => {
        infoContainer.innerHTML = '';
        if (item.groupName) {
            const groupTag = document.createElement('div');
            groupTag.className = 'ci-side-group-tag';
            groupTag.innerText = item.groupName;
            groupTag.title = `分组: ${item.groupName}`;
            infoContainer.appendChild(groupTag);
        }

        const activeIdx = subIdx ?? (item.selectedIndex || 0);
        const displayName = (item.imageNames?.[activeIdx] || '').trim() || `插图 ${activeIdx + 1}`;
        const nameBtn = document.createElement('div');
        nameBtn.className = 'ci-side-name-btn';
        nameBtn.innerText = displayName;
        nameBtn.title = '点击直接复制名称';

        nameBtn.onclick = async (e) => {
            e.stopPropagation();
            if (await copyTextDirectly(displayName)) {
                const prev = nameBtn.innerText;
                nameBtn.innerText = '已复制✓';
                setTimeout(() => { nameBtn.innerText = prev; }, 1200);
                toastr?.success?.(`已复制名称: ${displayName}`, '插图插件');
            }
        };
        infoContainer.appendChild(nameBtn);
    };

    if (subIdx === undefined && (item.images?.length || 0) > 1) {
        card._ciOpenPicker = () => {
            requestAnimationFrame(() => {
                openImagePickerModal(item, (chosenIdx) => {
                    item.selectedIndex = chosenIdx;
                    const newUrl = toDisplayUrl(item.images[chosenIdx]);
                    img.src = newUrl;
                    img.onclick = (ev) => { ev.stopPropagation(); window.openCIModal(newUrl); };
                    card._ciUpdateSideInfo?.(sideInfoContainer);
                    setTimeout(() => dbSetIllustrationSelectedIndex(item.id, chosenIdx), 10);
                });
            });
        };
    }

    if (isTopFixedMode) card.appendChild(innerCard);
    return card;
}

async function checkAndRenderMessage(messageEl) {
    if (!messageEl) return;
    const charId = getCurrentCharId(messageEl);
    if (!charId) return;

    if (messageEl.getAttribute('is_user') === 'true' && !allowUserTrigger) return;
    const textEl = messageEl.querySelector('.mes_text');
    if (!textEl) return;

    const rawMessageContent = getRawMessageContent(messageEl);
    if (!rawMessageContent?.trim()) return;

    const items = await dbGetIllustrations(charId);
    if (!items.length) {
        clearOldIllustrations();
        lastScannedText = rawMessageContent;
        return;
    }

    let listToDisplay = [];
    if (apiSettings.enabled && apiSettings.url && apiSettings.model) {
        const arbitratedIds = await arbitrateScenario(rawMessageContent, items);
        if (getCurrentCharId(messageEl) !== charId) return;
        if (Array.isArray(arbitratedIds)) {
            listToDisplay = items.filter(item => arbitratedIds.includes(item.id));
        } else {
            return;
        }
    } else {
        const lowerContent = rawMessageContent.toLowerCase();
        const matched = items.filter(item => {
            const list = item.rules || item.keywords;
            if (!Array.isArray(list)) return false;
            return list.some(group => {
                if (Array.isArray(group)) return group.length > 0 && group.every(kw => lowerContent.includes(kw.toLowerCase()));
                return typeof group === 'string' && lowerContent.includes(group.toLowerCase());
            });
        });

        if (matched.length === 0) {
            clearOldIllustrations();
            lastScannedText = rawMessageContent;
            return;
        }
        listToDisplay = showAllMatched ? matched : [matched[Math.floor(Math.random() * matched.length)]];
    }

    if (listToDisplay.length === 0) {
        clearOldIllustrations();
        lastScannedText = rawMessageContent;
        return;
    }

    const targetRenderKey = `${charId}_${displayPosition}_` + listToDisplay.map(item => `${item.id}:${singleImageMode ? (item.selectedIndex || 0) : 'all'}`).join(';');
    const isTopFixedMode = displayPosition === 'top_fixed' || displayPosition === 'top_fixed_scroll';
    const isHorizontalMode = displayPosition === 'top_scroll' || displayPosition === 'bottom_scroll' || displayPosition === 'top_fixed_scroll';

    const existingContainer = isTopFixedMode
        ? document.getElementById('ci-top-fixed-container')
        : (textEl.parentNode?.querySelector('.char-illustration-container') || messageEl.querySelector('.char-illustration-container'));

    if (existingContainer?.dataset?.renderKey === targetRenderKey && lastScannedText === rawMessageContent) return;

    lastScannedText = rawMessageContent;
    clearOldIllustrations();

    const container = document.createElement('div');
    container.dataset.renderKey = targetRenderKey;
    container.className = isTopFixedMode ? 'ci-top-fixed-container' : 'char-illustration-container';
    if (isTopFixedMode) container.id = 'ci-top-fixed-container';

    const carouselRoot = document.createElement('div');
    carouselRoot.className = isHorizontalMode ? 'ci-carousel-root ci-scroll-root' : 'ci-carousel-root';

    const expandBtn = document.createElement('div');
    expandBtn.className = 'char-illustration-expand-btn';
    expandBtn.innerHTML = '▶';
    expandBtn.title = '展开插图';

    const hintText = document.createElement('span');
    hintText.className = 'ci-collapsed-hint-text';
    hintText.innerText = '🖼️ [插图已折叠]';
    carouselRoot.appendChild(hintText);
    carouselRoot.appendChild(expandBtn);

    const mainWrapper = document.createElement('div');
    mainWrapper.className = isHorizontalMode ? 'ci-scroll-wrapper' : 'ci-carousel-wrapper';

    const prevBtn = document.createElement('button');
    prevBtn.className = 'ci-carousel-arrow ci-arrow-prev';
    prevBtn.innerHTML = '❮';
    prevBtn.title = '向左浏览';

    const nextBtn = document.createElement('button');
    nextBtn.className = 'ci-carousel-arrow ci-arrow-next';
    nextBtn.innerHTML = '❯';
    nextBtn.title = '向右浏览';

    const sideInfoContainer = document.createElement('div');
    sideInfoContainer.className = 'ci-side-info-container';

    const sideRightContainer = document.createElement('div');
    sideRightContainer.className = 'ci-side-right-container';

    const sideSwitchBtn = document.createElement('button');
    sideSwitchBtn.className = 'ci-side-switch-btn';
    sideSwitchBtn.innerText = '更换插图';
    sideSwitchBtn.title = '点击自选并锁定此规则展示的其他插图';
    sideSwitchBtn.style.display = 'none';

    const sideBadgeEl = document.createElement('div');
    sideBadgeEl.className = 'ci-side-badge';
    sideBadgeEl.innerText = '1/1';
    sideRightContainer.appendChild(sideSwitchBtn);
    sideRightContainer.appendChild(sideBadgeEl);

    const viewport = document.createElement('div');
    viewport.className = isHorizontalMode ? 'ci-scroll-viewport' : 'ci-carousel-viewport';

    const track = document.createElement('div');
    track.className = isHorizontalMode ? 'ci-scroll-track' : 'ci-carousel-track';

    viewport.appendChild(track);
    mainWrapper.appendChild(prevBtn);
    mainWrapper.appendChild(sideInfoContainer);
    mainWrapper.appendChild(viewport);
    mainWrapper.appendChild(nextBtn);
    mainWrapper.appendChild(sideRightContainer);

    if (isHorizontalMode) {
        const collapseBtn = document.createElement('div');
        collapseBtn.className = 'char-illustration-collapse-btn';
        collapseBtn.innerHTML = '◀';
        collapseBtn.title = '折叠/隐藏插图';
        collapseBtn.onclick = (e) => { e.stopPropagation(); carouselRoot.classList.add('ci-collapsed'); };
        mainWrapper.appendChild(collapseBtn);
        expandBtn.onclick = (e) => { e.stopPropagation(); carouselRoot.classList.remove('ci-collapsed'); };

        if (isTopFixedMode) {
            const sizeToggleBtn = document.createElement('div');
            sizeToggleBtn.className = 'ci-top-size-toggle-btn';
            sizeToggleBtn.innerHTML = topFixedSize === 'compact' ? '⛶' : '⧉';
            sizeToggleBtn.title = topFixedSize === 'compact' ? '切换为大图显示' : '切换为小图显示';

            sizeToggleBtn.onclick = (e) => {
                e.stopPropagation();
                let targetIdx = 0;
                if (typeof container._ciGetFocusedIndex === 'function') {
                    targetIdx = container._ciGetFocusedIndex();
                } else {
                    const rememberedId = activeSlideMemoryByChar.get(charId);
                    const slides = Array.from(track.querySelectorAll('.ci-scroll-slide'));
                    const fIdx = slides.findIndex(s => s.dataset.slideId === rememberedId);
                    if (fIdx !== -1) targetIdx = fIdx;
                }
                toggleFixedSize(container);
                container._ciRelockCenter?.(targetIdx);
            };
            mainWrapper.appendChild(sizeToggleBtn);
        }
    }

    carouselRoot.appendChild(mainWrapper);

    if (!isHorizontalMode) {
        const footer = document.createElement('div');
        footer.className = 'ci-carousel-footer';
        footer.innerHTML = `<div class="ci-carousel-dots"></div>`;
        carouselRoot.appendChild(footer);
    }
    container.appendChild(carouselRoot);

    for (const item of listToDisplay) {
        const imgs = item.images || [];
        if (!imgs.length) continue;

        if (singleImageMode) {
            let selectedIdx = typeof item.selectedIndex === 'number' ? item.selectedIndex : 0;
            if (selectedIdx < 0 || selectedIdx >= imgs.length) selectedIdx = 0;
            track.appendChild(buildCardElement({
                item,
                originalSource: imgs[selectedIdx],
                subIdx: undefined,
                isHorizontalMode,
                isTopFixedMode,
                container,
                carouselRoot,
                expandBtn,
                sideInfoContainer
            }));
        } else {
            for (let subIdx = 0; subIdx < imgs.length; subIdx++) {
                track.appendChild(buildCardElement({
                    item,
                    originalSource: imgs[subIdx],
                    subIdx,
                    isHorizontalMode,
                    isTopFixedMode,
                    container,
                    carouselRoot,
                    expandBtn,
                    sideInfoContainer
                }));
            }
        }
    }

    if (track.children.length === 0) return;

    if (isTopFixedMode) {
        (document.getElementById('sheld') || document.getElementById('chat') || document.body).appendChild(container);
    } else if (displayPosition === 'top' || displayPosition === 'top_scroll') {
        if (textEl?.parentNode) textEl.parentNode.insertBefore(container, textEl);
        else if (textEl) textEl.prepend(container);
        else messageEl.prepend(container);
    } else {
        textEl.appendChild(container);
    }

    // 绑定触摸穿透与分流引擎（只针对移动端触摸，电脑端完全不受影响）
    attachTouchPassThrough(carouselRoot);

    if (isHorizontalMode) setupHorizontalSmoothScroll(container, charId);
    else setupIllustrationCarousel(container, charId);
}

function scanLatestMessageOnly() {
    const messages = document.querySelectorAll('#chat .mes');
    if (messages.length) checkAndRenderMessage(messages[messages.length - 1]);
}

const debouncedScan = debounce(scanLatestMessageOnly, 300);

// ==================== 13. 生命周期与启动挂载 ====================
jQuery(async () => {
    initImageViewer();

    allowUserTrigger = localStorage.getItem('ci_allow_user_msg') === '1';
    showAllMatched = localStorage.getItem('ci_show_all_matched') !== '0';
    singleImageMode = localStorage.getItem('ci_single_image_mode') !== '0';

    let loadedPos = localStorage.getItem('ci_display_position') || 'top';
    if (loadedPos === 'horizontal_scroll') loadedPos = 'top_scroll';
    displayPosition = loadedPos;

    topFixedSize = localStorage.getItem('ci_top_fixed_size') || 'large';

    const drawerHtml = `
        <div id="char-illustrations-drawer" class="extension_settings">
            <div class="ci-custom-drawer">
                <div class="ci-custom-drawer-toggle" id="ci-drawer-toggle">
                    <b>角色插图管理 (Character Illustrations)</b>
                    <div class="ci-drawer-icon fa-solid fa-circle-chevron-up up"></div>
                </div>
                <div class="ci-custom-drawer-content" id="ci-settings-content" style="display: block;"></div>
            </div>
        </div>
    `;
    $('#extensions_settings').append(drawerHtml);

    let isDrawerOpen = true;
    $('#ci-drawer-toggle').on('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        isDrawerOpen = !isDrawerOpen;
        const content = $('#ci-settings-content');
        const icon = $('#ci-drawer-toggle .ci-drawer-icon');
        if (isDrawerOpen) {
            content.slideDown(200);
            icon.removeClass('fa-circle-chevron-down down').addClass('fa-circle-chevron-up up');
        } else {
            content.slideUp(200);
            icon.removeClass('fa-circle-chevron-up up').addClass('fa-circle-chevron-down down');
        }
    });

    await initDB();

    const handleCharChange = () => {
        invalidateCache();
        cachedStorageStats = null;
        lastScannedText = '';
        clearOldIllustrations();
        activeGroupFilter = '';
        renderSettings();
        debouncedScan();
    };

    eventSource.on(event_types.CHARACTER_PAGE_LOADED, handleCharChange);
    eventSource.on(event_types.CHAT_CHANGED, handleCharChange);
    eventSource.on(event_types.MESSAGE_RECEIVED, debouncedScan);

    if (event_types.GENERATION_ENDED) {
        eventSource.on(event_types.GENERATION_ENDED, debouncedScan);
    } else {
        eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, debouncedScan);
    }

    renderSettings();
    debouncedScan();
});