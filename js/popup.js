/**
 * Popup-окно рендерит состояния через условные render-функции:
 * авторизация, рабочий экран и информационные сообщения.
 */
const logger = createDebugLogger('popup');
const uiText = APP_CONFIG.uiText;
const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');

const popupAppTitle = document.getElementById('popup-app-title');
const popupAppDescription = document.getElementById('popup-app-description');
const popupAppVersion = document.getElementById('popup-app-version');
const popupContentRoot = document.getElementById('popup-content-root');
const popupTokenMeta = document.getElementById('popup-token-meta');
const popupTokenLabel = document.getElementById('popup-token-label');
const popupTokenEnd = document.getElementById('popup-token-end');
const popupTokenRefreshButton = document.getElementById('popup-token-refresh-button');
const popupOpenSettingsButton = document.getElementById('popup-open-settings-button');
const popupStopDownloadsButton = document.getElementById('popup-stop-downloads-button');
const popupDownloadStatus = document.getElementById('popup-download-status');
const defaultCoverImage = chrome.runtime.getURL('icons/app-icon.png');

const pendingTrackInfoRequestIds = {
    current: null,
    next: null
};

const MUSIC_TAB_PATTERNS = [
    'https://music.yandex.ru/*',
    'https://music.yandex.com/*',
    'https://music.yandex.kz/*',
    'https://music.yandex.by/*',
    'https://music.yandex.uz/*',
    'https://next.music.yandex.ru/*',
    'https://next.music.yandex.com/*',
    'https://next.music.yandex.kz/*',
    'https://next.music.yandex.by/*',
    'https://next.music.yandex.uz/*'
];

const TRACK_SLOT_CONFIG = Object.freeze({
    current: Object.freeze({
        slot: 'current',
        sectionTitle: uiText.popupCurrentTrack,
        hint: uiText.popupShortcuts,
        resolvingText: uiText.popupResolvingTrack,
        emptyText: uiText.popupEmptyTrack,
        trackIdKey: 'appYa_currentTrackId',
        trackKey: 'appYa_currentTrack',
        legacyTrackKey: 'appYa_cureitTrack'
    }),
    next: Object.freeze({
        slot: 'next',
        sectionTitle: uiText.popupNextTrack,
        hint: uiText.popupNextTrackHint,
        resolvingText: uiText.popupResolvingNextTrack,
        emptyText: uiText.popupNextTrackEmpty,
        trackIdKey: 'appYa_nextTrackId',
        trackKey: 'appYa_nextTrack',
        legacyTrackKey: null
    })
});

const COMPACT_TRACK_SLOT_CONFIG = Object.freeze({
    previous: Object.freeze({
        slot: 'previous',
        sectionTitle: uiText.popupPreviousTrack,
        emptyText: '',
        resolvingText: uiText.popupCompactTrackResolving,
        trackKey: 'appYa_previousTrack'
    }),
    next: Object.freeze({
        slot: 'next',
        sectionTitle: uiText.popupNextTrack,
        emptyText: uiText.popupNextTrackEmpty,
        resolvingText: uiText.popupCompactTrackResolving,
        trackKey: 'appYa_nextTrack'
    })
});

const escapeFileName = (fileName) => fileName.replace(/[\\/:*?"<>|]/g, '_');

function collectMissingElements(entries) {
    return entries
        .filter(([, element]) => !element)
        .map(([id]) => id);
}

const missingShellElementIds = collectMissingElements([
    ['popup-content-root', popupContentRoot],
    ['popup-token-meta', popupTokenMeta],
    ['popup-token-end', popupTokenEnd],
    ['popup-token-refresh-button', popupTokenRefreshButton],
    ['popup-open-settings-button', popupOpenSettingsButton],
    ['popup-stop-downloads-button', popupStopDownloadsButton],
    ['popup-download-status', popupDownloadStatus]
]);

const hasPopupShell = missingShellElementIds.length === 0;

logger.log('popup.js loaded');

if (!hasPopupShell) {
    logger.error('popup shell is incomplete', {missingShellElementIds});
}

if (popupAppTitle) {
    popupAppTitle.textContent = APP_CONFIG.appTitle;
}
if (popupAppDescription) {
    popupAppDescription.textContent = APP_CONFIG.appDescription || uiText.optionsSubtitle;
}
if (popupAppVersion) {
    popupAppVersion.textContent = APP_CONFIG.appVersion || '0.0.0';
}

if (popupOpenSettingsButton) {
    popupOpenSettingsButton.textContent = uiText.popupSettings;
}

if (popupStopDownloadsButton) {
    popupStopDownloadsButton.textContent = uiText.popupStopDownloads;
}

if (popupTokenLabel) {
    popupTokenLabel.textContent = uiText.popupTokenLabel;
}

if (popupTokenRefreshButton) {
    popupTokenRefreshButton.textContent = uiText.popupTokenRefresh;
}

document.title = APP_CONFIG.appTitle;

if (hasPopupShell) {
    popupOpenSettingsButton.addEventListener('click', function () {
        if (chrome.runtime.openOptionsPage) {
            chrome.runtime.openOptionsPage();
        } else {
            window.open(chrome.runtime.getURL('html/options.html'));
        }
    });
}

const storageService = {
    getStorageData(callback) {
        chrome.storage.local.get((result) => callback(result));
    },

    monitorStorageChanges(callback) {
        chrome.storage.onChanged.addListener((changes, areaName) => {
            void areaName;
            callback(changes);
        });
    }
};

function createChromePromise(invoker) {
    return new Promise((resolve, reject) => {
        try {
            invoker((result) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                resolve(result);
            });
        } catch (error) {
            reject(error);
        }
    });
}

const tabService = {
    queryTabs(queryInfo) {
        return createChromePromise((callback) => chrome.tabs.query(queryInfo, callback))
            .catch((error) => {
                logger.warn('tabs.query failed', error?.message || String(error));
                return [];
            });
    },

    getTab(tabId) {
        if (typeof tabId !== 'number') {
            return Promise.resolve(null);
        }

        return createChromePromise((callback) => chrome.tabs.get(tabId, callback))
            .catch((error) => {
                logger.warn('tabs.get failed', {tabId, message: error?.message || String(error)});
                return null;
            });
    },

    updateTab(tabId, updateProperties) {
        return createChromePromise((callback) => chrome.tabs.update(tabId, updateProperties, callback));
    },

    createTab(createProperties) {
        return createChromePromise((callback) => chrome.tabs.create(createProperties, callback));
    },

    isMusicUrl(url) {
        return typeof url === 'string'
            && /^https:\/\/(?:next\.)?music\.yandex\.(?:ru|com|kz|by|uz)\//.test(url);
    },

    async resolveMusicTabContext(storedTabId) {
        const preferredTab = await this.getTab(storedTabId);
        if (preferredTab && this.isMusicUrl(preferredTab.url || preferredTab.pendingUrl)) {
            return {
                tabId: preferredTab.id,
                actionLabel: uiText.popupActivateMusic
            };
        }

        const musicTabs = await this.queryTabs({url: MUSIC_TAB_PATTERNS});
        const firstMusicTab = musicTabs.find((tab) => this.isMusicUrl(tab.url || tab.pendingUrl));

        if (firstMusicTab) {
            return {
                tabId: firstMusicTab.id,
                actionLabel: uiText.popupActivateMusic
            };
        }

        return {
            tabId: null,
            actionLabel: uiText.popupOpenMusic
        };
    }
};

function resolveCoverUrl(coverUri, coverSize) {
    return coverUri ? `https://${coverUri.replace(/%%/g, coverSize)}` : defaultCoverImage;
}

function resolveTrackImage(track, coverSize) {
    if (track?.coverUrl) {
        return track.coverUrl;
    }

    return resolveCoverUrl(track?.coverUri, coverSize);
}

function parseColor(colorValue) {
    if (!colorValue || typeof colorValue !== 'string') {
        return null;
    }

    const value = colorValue.trim();
    const shortHexMatch = value.match(/^#([0-9a-f]{3})$/i);
    if (shortHexMatch) {
        const [r, g, b] = shortHexMatch[1].split('').map((part) => parseInt(part + part, 16));
        return {r, g, b};
    }

    const longHexMatch = value.match(/^#([0-9a-f]{6})$/i);
    if (longHexMatch) {
        return {
            r: parseInt(longHexMatch[1].slice(0, 2), 16),
            g: parseInt(longHexMatch[1].slice(2, 4), 16),
            b: parseInt(longHexMatch[1].slice(4, 6), 16)
        };
    }

    const rgbMatch = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (rgbMatch) {
        return {
            r: Number(rgbMatch[1]),
            g: Number(rgbMatch[2]),
            b: Number(rgbMatch[3])
        };
    }

    return null;
}

function getRelativeLuminance({r, g, b}) {
    const [rs, gs, bs] = [r, g, b].map((channel) => {
        const normalized = channel / 255;
        return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
    });

    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrastingTextColor(backgroundColor) {
    const parsedBackground = parseColor(backgroundColor);
    if (!parsedBackground) {
        return '#f4efe5';
    }

    return getRelativeLuminance(parsedBackground) > 0.45 ? '#101217' : '#f8f6f2';
}

function toAlphaColor(baseColor, alpha) {
    const parsedColor = parseColor(baseColor);
    if (!parsedColor) {
        return baseColor;
    }

    return `rgba(${parsedColor.r}, ${parsedColor.g}, ${parsedColor.b}, ${alpha})`;
}

function applyTrackPanelTheme(trackRefs, derivedColors = {}) {
    const backgroundColor = derivedColors.accent || '';
    const computedTextColor = parseColor(derivedColors.waveText)
        ? derivedColors.waveText
        : getContrastingTextColor(backgroundColor);
    const isLightBackground = getContrastingTextColor(backgroundColor) === '#101217';

    trackRefs.panel.style.backgroundColor = backgroundColor;
    trackRefs.panel.style.setProperty('--popup-track-text', computedTextColor);
    trackRefs.panel.style.setProperty(
        '--popup-track-muted',
        toAlphaColor(computedTextColor, isLightBackground ? 0.76 : 0.84)
    );
    trackRefs.panel.style.setProperty(
        '--popup-track-button-bg',
        isLightBackground ? 'rgba(16, 18, 23, 0.92)' : 'rgba(248, 246, 242, 0.9)'
    );
    trackRefs.panel.style.setProperty(
        '--popup-track-button-text',
        isLightBackground ? '#f8f6f2' : '#101217'
    );
    trackRefs.panel.style.setProperty('--popup-track-button-border', 'transparent');
}

function pickFirstTrackId(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).find(Boolean) || null;
    }

    if (value === null || value === undefined) {
        return null;
    }

    return String(value)
        .split(',')
        .map((item) => item.trim())
        .find(Boolean) || null;
}

function extractTrackIdFromFileInfoPayload(payload) {
    if (!payload) {
        return null;
    }

    const directTrackId = pickFirstTrackId(payload.trackId)
        || pickFirstTrackId(payload.trackIds)
        || pickFirstTrackId(payload.result?.trackId)
        || pickFirstTrackId(payload.result?.trackIds)
        || pickFirstTrackId(payload.result?.downloadInfo?.trackId)
        || pickFirstTrackId(payload.downloadInfo?.trackId);

    if (directTrackId) {
        return directTrackId;
    }

    const result = payload.result;
    if (Array.isArray(result)) {
        for (const item of result) {
            const nestedTrackId = pickFirstTrackId(item?.trackId)
                || pickFirstTrackId(item?.trackIds)
                || pickFirstTrackId(item?.downloadInfo?.trackId);
            if (nestedTrackId) {
                return nestedTrackId;
            }
        }
        return null;
    }

    if (result && typeof result === 'object') {
        for (const [candidateTrackId, candidateValue] of Object.entries(result)) {
            if (candidateValue && typeof candidateValue === 'object') {
                return pickFirstTrackId(candidateValue.trackId)
                    || pickFirstTrackId(candidateValue.trackIds)
                    || pickFirstTrackId(candidateValue.downloadInfo?.trackId)
                    || pickFirstTrackId(candidateTrackId);
            }
        }
    }

    return null;
}

function extractTrackIdFromPlaysPayload(payload) {
    if (!payload) {
        return null;
    }

    const directTrackId = pickFirstTrackId(payload.trackId)
        || pickFirstTrackId(payload.track?.id)
        || pickFirstTrackId(payload.result?.trackId)
        || pickFirstTrackId(payload.result?.track?.id);

    if (directTrackId) {
        return directTrackId;
    }

    const collections = [
        payload.plays,
        payload.result?.plays,
        Array.isArray(payload.result) ? payload.result : null
    ];

    for (const collection of collections) {
        if (!Array.isArray(collection)) {
            continue;
        }

        for (const item of collection) {
            const nestedTrackId = pickFirstTrackId(item?.trackId) || pickFirstTrackId(item?.track?.id);
            if (nestedTrackId) {
                return nestedTrackId;
            }
        }
    }

    return null;
}

function getTrackSlotConfig(slot) {
    return slot === 'next' ? TRACK_SLOT_CONFIG.next : TRACK_SLOT_CONFIG.current;
}

function resolveCurrentTrackId(parsedData) {
    return pickFirstTrackId(parsedData.appYa_currentTrackId)
        || extractTrackIdFromPlaysPayload(parsedData.appYa_plays);
}

function resolveNextTrackId(parsedData) {
    const currentTrackId = resolveCurrentTrackId(parsedData);
    const nextTrackId = pickFirstTrackId(parsedData.appYa_nextTrackId)
        || extractTrackIdFromFileInfoPayload(parsedData['appYa_get-file-info']);

    if (!nextTrackId || nextTrackId === currentTrackId) {
        return null;
    }

    return nextTrackId;
}

function resolveTrackIdForSlot(parsedData, slot) {
    return slot === 'next'
        ? resolveNextTrackId(parsedData)
        : resolveCurrentTrackId(parsedData);
}

function getCachedTrackData(parsedData, slot) {
    const config = getTrackSlotConfig(slot);
    return parsedData[config.trackKey]
        || (config.legacyTrackKey ? parsedData[config.legacyTrackKey] : null)
        || null;
}

function getTrackArtistsText(track) {
    return Array.isArray(track?.artists)
        ? track.artists.map((item) => item.name).filter(Boolean).join(', ')
        : '';
}

function getTrackSecondaryText(track) {
    const albumTitles = Array.isArray(track?.albums)
        ? track.albums.map((item) => item?.title).filter(Boolean)
        : [];

    if (albumTitles.length > 0) {
        return albumTitles.join(', ');
    }

    const years = Array.isArray(track?.albums)
        ? track.albums.map((item) => item?.year).filter(Boolean)
        : [];

    return years.join(', ');
}

function getCompactTrackConfig(slot) {
    return slot === 'previous'
        ? COMPACT_TRACK_SLOT_CONFIG.previous
        : COMPACT_TRACK_SLOT_CONFIG.next;
}

function getCompactTrackData(parsedData, slot) {
    const config = getCompactTrackConfig(slot);
    return parsedData[config.trackKey] || null;
}

function setPlaylistDownloadButton(button, label, counter = '') {
    const textNode = button.querySelector('.text');
    const counterNode = button.querySelector('.counter');

    if (textNode) {
        textNode.innerText = label;
    } else {
        button.innerText = label;
    }

    if (counterNode) {
        counterNode.innerText = counter;
        counterNode.style.display = counter ? 'inline-block' : 'none';
    }
}

const renderer = {
    renderState(message, actionLabel = '') {
        popupContentRoot.innerHTML = `
            <section class="popup-state">
                <p class="popup-state-text mb-0"></p>
                <button type="button" class="btn btn-warning mt-3" id="popup-state-action-button" hidden></button>
            </section>
        `;

        const root = popupContentRoot.firstElementChild;
        const actionButton = root.querySelector('#popup-state-action-button');
        root.querySelector('.popup-state-text').textContent = message;

        if (actionLabel) {
            actionButton.hidden = false;
            actionButton.textContent = actionLabel;
        }

        popupTokenMeta.hidden = true;
        return {root, actionButton};
    },

    renderAuth(authorizeUrl, appYaTabId) {
        popupContentRoot.innerHTML = `
            <section class="popup-auth">
                <h2 class="h4 mb-2 popup-auth-title"></h2>
                <p class="popup-auth-description"></p>
                <a target="_blank" href="#" class="btn btn-warning" id="popup-authorize-link"></a>
            </section>
        `;

        const root = popupContentRoot.firstElementChild;
        const authTitle = root.querySelector('.popup-auth-title');
        const authDescription = root.querySelector('.popup-auth-description');
        const authorizeButton = root.querySelector('#popup-authorize-link');

        authTitle.textContent = uiText.popupAuthTitle;
        authDescription.textContent = uiText.popupAuthDescription;
        authorizeButton.textContent = uiText.popupAuthorize;
        authorizeButton.href = authorizeUrl || '#';

        window.setTimeout(() => {
            authorizeButton.onclick = () => {
                if (typeof appYaTabId !== 'number') {
                    return;
                }

                chrome.tabs.remove(appYaTabId, () => {
                    if (chrome.runtime.lastError) {
                        logger.error('failed to close authorization tab', chrome.runtime.lastError);
                    } else {
                        logger.log('authorization tab closed');
                    }
                });
            };
        }, 1500);

        popupTokenMeta.hidden = true;
        return {root, authorizeButton};
    },

    renderTrackPanelMarkup(slot) {
        const config = getTrackSlotConfig(slot);

        return `
            <section class="popup-track-section" id="popup-track-section-${slot}">
                <strong class="popup-section-title">${config.sectionTitle}</strong>
                <div id="popup-track-panel-${slot}" class="popup-panel">
                    <img id="popup-track-image-${slot}" src="${defaultCoverImage}" class="popup-image" alt="Track Image">
                    <div class="popup-panel-body">
                        <h5 id="popup-track-title-${slot}" class="popup-track-title text-center"></h5>
                        <p id="popup-track-meta-${slot}" class="popup-meta text-center mb-0"></p>
                        <div class="popup-actions d-grid gap-2">
                            <button id="popup-track-download-button-${slot}" type="button" class="btn btn-dark btn-sm"></button>
                            <small id="popup-track-shortcuts-${slot}" class="popup-hint text-center"></small>
                        </div>
                    </div>
                </div>
            </section>
        `;
    },

    renderCompactTrackMarkup(slot) {
        const config = getCompactTrackConfig(slot);

        return `
            <section class="popup-compact-track-section" id="popup-compact-track-section-${slot}" hidden>
                <strong class="popup-section-title">${config.sectionTitle}</strong>
                <div class="popup-compact-track" id="popup-compact-track-${slot}">
                    <img id="popup-compact-track-image-${slot}" src="${defaultCoverImage}" class="popup-compact-track-image" alt="Track Image">
                    <div class="popup-compact-track-body">
                        <div id="popup-compact-track-title-${slot}" class="popup-compact-track-title"></div>
                        <div id="popup-compact-track-meta-${slot}" class="popup-compact-track-meta"></div>
                    </div>
                    <button id="popup-compact-track-download-button-${slot}" type="button" class="btn btn-dark btn-sm popup-compact-track-button"></button>
                </div>
            </section>
        `;
    },

    collectTrackCardRefs(root, slot) {
        return {
            section: root.querySelector(`#popup-track-section-${slot}`),
            panel: root.querySelector(`#popup-track-panel-${slot}`),
            image: root.querySelector(`#popup-track-image-${slot}`),
            title: root.querySelector(`#popup-track-title-${slot}`),
            meta: root.querySelector(`#popup-track-meta-${slot}`),
            downloadButton: root.querySelector(`#popup-track-download-button-${slot}`),
            hint: root.querySelector(`#popup-track-shortcuts-${slot}`)
        };
    },

    collectCompactTrackRefs(root, slot) {
        return {
            section: root.querySelector(`#popup-compact-track-section-${slot}`),
            container: root.querySelector(`#popup-compact-track-${slot}`),
            image: root.querySelector(`#popup-compact-track-image-${slot}`),
            title: root.querySelector(`#popup-compact-track-title-${slot}`),
            meta: root.querySelector(`#popup-compact-track-meta-${slot}`),
            downloadButton: root.querySelector(`#popup-compact-track-download-button-${slot}`)
        };
    },

    renderWork() {
        popupContentRoot.innerHTML = `
            <div class="popup-work">
                <div class="popup-grid" id="popup-grid">
                    <section class="popup-column" id="popup-track-column">
                        <div class="popup-track-stack">
                            ${this.renderTrackPanelMarkup('current')}
                            <section class="popup-compact-track-list">
                                <strong class="popup-section-title">${uiText.popupAdjacentTracks}</strong>
                                <div class="popup-compact-track-stack">
                                    ${this.renderCompactTrackMarkup('previous')}
                                    ${this.renderCompactTrackMarkup('next')}
                                </div>
                            </section>
                        </div>
                    </section>

                    <section class="popup-column" id="popup-entity-column">
                        <div class="popup-entity-panel">
                            <strong id="popup-entity-title" class="popup-section-title d-block mb-2"></strong>
                            <div class="popup-panel">
                                <img id="popup-entity-image" src="${defaultCoverImage}" class="popup-image" alt="Track Image">
                                <div class="popup-panel-body">
                                    <pre id="popup-entity-meta"></pre>

                                    <div id="popup-range-panel" class="popup-range" hidden>
                                        <div class="d-flex justify-content-between align-items-center mb-1 popup-range-meta">
                                            <span id="popup-range-label-text" class="text-muted"></span>
                                            <b id="popup-range-value" class="text-primary">1 — 1</b>
                                        </div>
                                        <div class="range-controls px-1">
                                            <small class="text-muted popup-range-label"></small>
                                            <input type="range" class="form-range" id="popup-range-start" min="1" step="1">
                                            <small class="text-muted popup-range-label"></small>
                                            <input type="range" class="form-range" id="popup-range-end" min="1" step="1">
                                        </div>
                                    </div>

                                    <div class="mt-3">
                                        <button id="popup-entity-download-button" type="button" class="btn btn-dark btn-sm text-center position-relative popup-entity-download-button" hidden>
                                            <span class="text">...</span>
                                            <span class="counter position-absolute top-0 start-100 translate-middle badge rounded-pill bg-danger">0</span>
                                        </button>
                                    </div>

                                    <div id="popup-entity-extra" class="popup-entity-extra"></div>
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            </div>
        `;

        const root = popupContentRoot.firstElementChild;
        const refs = {
            root,
            popupGrid: root.querySelector('#popup-grid'),
            popupTrackColumn: root.querySelector('#popup-track-column'),
            popupEntityColumn: root.querySelector('#popup-entity-column'),
            popupCompactTrackList: root.querySelector('.popup-compact-track-list'),
            trackCards: {
                current: this.collectTrackCardRefs(root, 'current')
            },
            compactTrackCards: {
                previous: this.collectCompactTrackRefs(root, 'previous'),
                next: this.collectCompactTrackRefs(root, 'next')
            },
            popupEntityTitle: root.querySelector('#popup-entity-title'),
            popupEntityImage: root.querySelector('#popup-entity-image'),
            popupEntityMeta: root.querySelector('#popup-entity-meta'),
            popupEntityExtra: root.querySelector('#popup-entity-extra'),
            popupEntityDownloadButton: root.querySelector('#popup-entity-download-button'),
            popupRangePanel: root.querySelector('#popup-range-panel'),
            popupRangeLabelText: root.querySelector('#popup-range-label-text'),
            popupRangeValue: root.querySelector('#popup-range-value'),
            popupRangeStart: root.querySelector('#popup-range-start'),
            popupRangeEnd: root.querySelector('#popup-range-end'),
            rangeLabels: root.querySelectorAll('.popup-range-label')
        };

        refs.trackCards.current.downloadButton.textContent = uiText.parserButtonDefault;
        refs.trackCards.current.hint.textContent = uiText.popupShortcuts;
        refs.compactTrackCards.previous.downloadButton.textContent = uiText.parserButtonDefault;
        refs.compactTrackCards.next.downloadButton.textContent = uiText.parserButtonDefault;
        refs.popupRangeLabelText.textContent = uiText.popupTrackRangeLabel;

        if (refs.rangeLabels[0]) {
            refs.rangeLabels[0].textContent = uiText.popupTrackRangeStart;
        }
        if (refs.rangeLabels[1]) {
            refs.rangeLabels[1].textContent = uiText.popupTrackRangeEnd;
        }

        return refs;
    },

    renderArtistAlbums(albums, host) {
        const section = document.createElement('section');
        const divider = document.createElement('hr');
        const titleNode = document.createElement('strong');
        const listNode = document.createElement('div');

        section.className = 'popup-related';
        titleNode.className = 'd-block mb-2';
        listNode.className = 'list-group';
        titleNode.textContent = uiText.popupAlbumsSection;

        albums.forEach((album) => {
            const link = document.createElement('a');
            const badge = document.createElement('span');

            link.className = 'album-link list-group-item list-group-item-action';
            link.href = '#';
            link.dataset.urlTab = `${host}/album/${album.id}`;
            link.textContent = `${album.title} - ${album.year} `;

            badge.className = 'badge bg-danger';
            badge.textContent = album.trackCount;
            link.appendChild(badge);
            listNode.appendChild(link);
        });

        section.append(divider, titleNode, listNode);
        return section;
    }
};

const uiUpdater = {
    applyTheme(theme) {
        const resolvedTheme = theme === 'auto'
            ? (themeMedia.matches ? 'dark' : 'light')
            : theme;
        document.documentElement.setAttribute('data-bs-theme', resolvedTheme);
        logger.log('popup theme applied', {theme, resolvedTheme});
    },

    updateDownloadState(downloadState) {
        if (!popupStopDownloadsButton || !popupDownloadStatus) {
            return;
        }

        const normalizedState = downloadState || {};
        const isActive = Boolean(normalizedState.isActive);
        const stopRequested = Boolean(normalizedState.stopRequested);
        const remainingCount = Number(normalizedState.remainingCount || 0);

        popupStopDownloadsButton.textContent = stopRequested
            ? uiText.popupStoppingDownloads
            : uiText.popupStopDownloads;
        popupStopDownloadsButton.disabled = !isActive || stopRequested;

        if (!isActive) {
            popupDownloadStatus.textContent = uiText.popupDownloadQueueIdle;
            return;
        }

        const statusPrefix = stopRequested
            ? uiText.popupDownloadQueueStopping
            : uiText.popupDownloadQueueActive;
        popupDownloadStatus.textContent = `${statusPrefix}: ${remainingCount}`;
    },

    resetTrackCard(trackRefs, slot) {
        const config = getTrackSlotConfig(slot);

        trackRefs.panel.style.backgroundColor = '';
        trackRefs.panel.style.removeProperty('--popup-track-text');
        trackRefs.panel.style.removeProperty('--popup-track-muted');
        trackRefs.panel.style.removeProperty('--popup-track-button-bg');
        trackRefs.panel.style.removeProperty('--popup-track-button-text');
        trackRefs.panel.style.removeProperty('--popup-track-button-border');
        trackRefs.image.src = defaultCoverImage;
        trackRefs.title.textContent = config.emptyText;
        trackRefs.meta.textContent = '';
        trackRefs.downloadButton.disabled = true;
        trackRefs.downloadButton.textContent = uiText.parserButtonDefault;
        trackRefs.downloadButton.onclick = null;
        trackRefs.hint.textContent = config.hint;
        trackRefs.section.hidden = false;
    },

    resetCompactTrackCard(trackRefs, slot) {
        const config = getCompactTrackConfig(slot);

        trackRefs.section.hidden = true;
        trackRefs.image.src = defaultCoverImage;
        trackRefs.title.textContent = config.emptyText;
        trackRefs.meta.textContent = '';
        trackRefs.downloadButton.disabled = true;
        trackRefs.downloadButton.textContent = uiText.parserButtonDefault;
        trackRefs.downloadButton.onclick = null;
    },

    resetPlaylistInfo(refs) {
        refs.popupGrid.classList.remove('popup-grid--single');
        refs.popupTrackColumn.classList.remove('popup-column--full');
        refs.popupEntityColumn.hidden = false;

        refs.popupEntityTitle.textContent = '';
        refs.popupEntityImage.src = defaultCoverImage;
        refs.popupEntityMeta.textContent = '';
        refs.popupEntityExtra.replaceChildren();
        refs.popupEntityExtra.onclick = null;
        refs.popupRangePanel.hidden = true;
        refs.popupEntityDownloadButton.hidden = true;
        refs.popupEntityDownloadButton.onclick = null;
        setPlaylistDownloadButton(refs.popupEntityDownloadButton, '...', '');
    },

    updateTokenInfo(tokenData, appYaTabId) {
        popupTokenMeta.hidden = false;
        popupTokenEnd.textContent = this.getTokenExpirationDate(tokenData);
        popupTokenRefreshButton.onclick = async function (event) {
            event.preventDefault();
            await chrome.storage.local.remove(APP_CONFIG.storageKeys.database);

            if (typeof appYaTabId !== 'number') {
                window.close();
                return;
            }

            chrome.scripting.executeScript({
                target: {tabId: appYaTabId},
                func: () => {
                    const keysToRemove = [];

                    for (let index = 0; index < localStorage.length; index += 1) {
                        const key = localStorage.key(index);
                        if (key && key.startsWith('appYa_')) {
                            keysToRemove.push(key);
                        }
                    }

                    keysToRemove.forEach((key) => localStorage.removeItem(key));
                    window.location.reload();
                },
                world: 'MAIN',
            }, () => {
                window.close();
            });
        };
    },

    updateTrackCard(parsedData, appYaTabId, coverSize, trackRefs, slot) {
        this.resetTrackCard(trackRefs, slot);

        const config = getTrackSlotConfig(slot);
        const expectedTrackId = resolveTrackIdForSlot(parsedData, slot);

        if (!expectedTrackId) {
            trackRefs.meta.textContent = uiText.popupEmptyState;
            return false;
        }

        const cachedTrackData = getCachedTrackData(parsedData, slot);
        const cachedTrackId = pickFirstTrackId(cachedTrackData?.trackinfo?.id);
        const hasFreshTrackInfo = Boolean(
            cachedTrackData
            && cachedTrackId
            && cachedTrackId === expectedTrackId
        );

        if (!hasFreshTrackInfo) {
            trackRefs.title.textContent = config.resolvingText;
            trackRefs.meta.textContent = '';
            if (slot !== 'current') {
                eventHandlers.resolveTrackInfo(expectedTrackId, slot);
                logger.log('popup requested track info', {slot, trackId: expectedTrackId});
            }
            return false;
        }

        pendingTrackInfoRequestIds[slot] = null;

        const track = cachedTrackData.trackinfo;
        const imageURL = resolveTrackImage(track, coverSize);
        const artists = getTrackArtistsText(track);
        const secondaryText = getTrackSecondaryText(track);

        trackRefs.title.innerText = track.title;
        trackRefs.meta.innerHTML = secondaryText
            ? `${artists}<br>${secondaryText}`
            : artists;
        trackRefs.image.src = imageURL;
        applyTrackPanelTheme(trackRefs, track.derivedColors);
        trackRefs.downloadButton.disabled = false;
        trackRefs.downloadButton.onclick = () => {
            eventHandlers.downloadTracks(appYaTabId, [track.id], 'music');
        };

        logger.log('rendering track card', {
            slot,
            trackId: track.id,
            title: track.title,
            artists
        });

        return true;
    },

    updateCompactTrackCard(parsedData, appYaTabId, coverSize, trackRefs, slot) {
        this.resetCompactTrackCard(trackRefs, slot);

        const compactConfig = getCompactTrackConfig(slot);
        const expectedTrackId = slot === 'next'
            ? resolveNextTrackId(parsedData)
            : pickFirstTrackId(parsedData.appYa_previousTrack?.trackinfo?.id);

        if (!expectedTrackId && slot === 'next') {
            return false;
        }

        const cachedTrackData = getCompactTrackData(parsedData, slot);
        const cachedTrackId = pickFirstTrackId(cachedTrackData?.trackinfo?.id);
        const hasFreshTrackInfo = Boolean(
            cachedTrackData
            && cachedTrackId
            && (!expectedTrackId || cachedTrackId === expectedTrackId)
        );

        if (!hasFreshTrackInfo) {
            if (slot === 'next' && expectedTrackId) {
                trackRefs.section.hidden = false;
                trackRefs.title.textContent = compactConfig.resolvingText;
                trackRefs.meta.textContent = '';
                eventHandlers.resolveTrackInfo(expectedTrackId, 'next');
                logger.log('popup requested compact next track info', {trackId: expectedTrackId});
                return true;
            }

            return false;
        }

        if (slot === 'next') {
            pendingTrackInfoRequestIds.next = null;
        }

        const track = cachedTrackData.trackinfo;
        const artists = getTrackArtistsText(track);

        trackRefs.section.hidden = false;
        trackRefs.image.src = resolveTrackImage(track, coverSize);
        trackRefs.title.textContent = track.title || compactConfig.sectionTitle;
        trackRefs.meta.textContent = artists || getTrackSecondaryText(track);
        trackRefs.downloadButton.disabled = !track.id;
        trackRefs.downloadButton.onclick = track.id
            ? () => eventHandlers.downloadTracks(appYaTabId, [track.id], 'music')
            : null;

        return true;
    },

    updateUI(data, appYaTabId, app, musicTabContext) {
        const parsedData = parser.parseStorage(data);
        const settings = normalizeSettings(app?.[APP_CONFIG.storageKeys.settings]);
        const coverQuality = settings.coverQuality ?? APP_CONFIG.defaults.coverQuality;
        const coverSize = `${coverQuality}x${coverQuality}`;
        const effectiveTabId = musicTabContext?.tabId ?? appYaTabId;

        this.applyTheme(settings.theme);
        this.updateDownloadState(app?.[APP_CONFIG.storageKeys.downloadState]);

        logger.log('updateUI called', {
            tabId: effectiveTabId,
            coverSize,
            hasToken: Boolean(parsedData.appYa_token),
            hasPage: Boolean(parsedData.appYa_page)
        });

        if (typeof effectiveTabId !== 'number') {
            const stateView = renderer.renderState(
                uiText.popupMusicTabState,
                musicTabContext?.actionLabel || uiText.popupOpenMusic
            );
            stateView.actionButton.onclick = () => eventHandlers.openOrActivateMusicTab(appYaTabId);
            return;
        }

        if (!parsedData.appYa_token) {
            if (parsedData.appYa_authorizationUrl) {
                renderer.renderAuth(parsedData.appYa_authorizationUrl, effectiveTabId);
            } else {
                const stateView = renderer.renderState(uiText.popupMusicTabState, uiText.popupActivateMusic);
                stateView.actionButton.onclick = () => eventHandlers.openOrActivateMusicTab(effectiveTabId);
            }
            return;
        }

        this.updateTokenInfo(parsedData.appYa_token, effectiveTabId);
        const refs = renderer.renderWork();
        this.updateTrackCard(parsedData, effectiveTabId, coverSize, refs.trackCards.current, 'current');
        const hasPreviousTrack = this.updateCompactTrackCard(parsedData, effectiveTabId, coverSize, refs.compactTrackCards.previous, 'previous');
        const hasNextTrack = this.updateCompactTrackCard(parsedData, effectiveTabId, coverSize, refs.compactTrackCards.next, 'next');
        refs.popupCompactTrackList.hidden = !hasPreviousTrack && !hasNextTrack;
        this.updatePlaylistInfo(parsedData, effectiveTabId, coverSize, refs);
    },

    updatePlaylistInfo(parsedData, appYaTabId, coverSize, refs) {
        this.resetPlaylistInfo(refs);

        const pageData = parsedData.appYa_page || {};
        const playlist = pageData.playlist;
        const artist = pageData.artist;
        const album = pageData.album;
        const chart = pageData.chart;

        if (playlist && playlist.items && playlist.meta) {
            const title = playlist.meta.title.replace(':', '_');
            const trackIds = playlist.items.map((track) => track.id);
            const totalTracks = trackIds.length;

            refs.popupEntityTitle.innerText = `${uiText.popupPlaylistTitle}: ${title}`;
            refs.popupEntityMeta.innerHTML = `${uiText.popupPlaylistMetaAuthor}: ${playlist.meta.owner.name}<br>${uiText.popupPlaylistMetaCount}: ${totalTracks}`;
            refs.popupEntityImage.src = resolveCoverUrl(playlist.meta.coverUri, coverSize);

            if (totalTracks > 1) {
                refs.popupRangePanel.hidden = false;
                refs.popupRangeStart.max = totalTracks;
                refs.popupRangeEnd.max = totalTracks;
                refs.popupRangeStart.value = 1;
                refs.popupRangeEnd.value = totalTracks;

                const updateRangeUI = () => {
                    let start = parseInt(refs.popupRangeStart.value, 10);
                    let end = parseInt(refs.popupRangeEnd.value, 10);

                    if (start > end) {
                        refs.popupRangeStart.value = end;
                        start = end;
                    }

                    refs.popupRangeValue.innerText = (start === 1 && end === totalTracks)
                        ? `${uiText.popupRangeAll} (${totalTracks})`
                        : `${start} — ${end} (${uiText.popupRangeCount}: ${end - start + 1})`;
                };

                refs.popupRangeStart.oninput = updateRangeUI;
                refs.popupRangeEnd.oninput = updateRangeUI;
                updateRangeUI();
            }

            refs.popupEntityDownloadButton.hidden = false;
            setPlaylistDownloadButton(refs.popupEntityDownloadButton, uiText.popupDownloadSelected);
            refs.popupEntityDownloadButton.onclick = () => {
                const startIdx = parseInt(refs.popupRangeStart.value, 10) - 1;
                const endIdx = parseInt(refs.popupRangeEnd.value, 10);
                const idsToDownload = refs.popupRangePanel.hidden
                    ? trackIds
                    : trackIds.slice(startIdx, endIdx);

                eventHandlers.downloadTracks(appYaTabId, idsToDownload, `playlist/${title}`);
            };

            return;
        }

        if (artist && artist?.fullTracksListSubpage?.ids?.length) {
            let title = uiText.popupArtistFallbackTitle;
            let coverUri = defaultCoverImage;

            if (artist.meta) {
                title = artist.meta.artist.name.replace(':', '_');
                coverUri = resolveCoverUrl(artist.meta.artist.coverUri, coverSize);
            } else {
                if (artist.commonSubPage?.artistName) {
                    title = artist.commonSubPage.artistName.replace(':', '_');
                }
                if (artist.lastRelease?.coverUri) {
                    coverUri = resolveCoverUrl(artist.lastRelease.coverUri, coverSize);
                }
            }

            const trackIds = artist.fullTracksListSubpage.ids;
            refs.popupEntityTitle.innerText = `${uiText.popupArtistTitle}: ${title}`;
            refs.popupEntityImage.src = coverUri;
            refs.popupEntityMeta.innerHTML = `${uiText.popupPlaylistMetaCount}: ${trackIds.length}`;

            refs.popupEntityDownloadButton.hidden = false;
            setPlaylistDownloadButton(refs.popupEntityDownloadButton, uiText.popupDownloadArtist, `${trackIds.length}`);
            refs.popupEntityDownloadButton.onclick = () => {
                eventHandlers.downloadTracks(appYaTabId, trackIds, `artist/${escapeFileName(title)}`);
            };

            const albums = artist.albums ?? [];
            if (albums.length > 0) {
                refs.popupEntityExtra.replaceChildren(
                    renderer.renderArtistAlbums(albums, parsedData.appYa_hosting)
                );

                refs.popupEntityExtra.onclick = (event) => {
                    const link = event.target.closest('[data-url-tab]');
                    if (!link) {
                        return;
                    }

                    event.preventDefault();
                    eventHandlers.changeTabUrl(appYaTabId, link.getAttribute('data-url-tab'));
                };
            }

            return;
        }

        if (album && album?.items?.length) {
            const year = album.meta?.year ? ` - ${album.meta.year}` : '';
            const title = `${album.meta.title.replace(':', '_')}${year}`;
            const trackIds = album.items.map((track) => track.id);

            refs.popupEntityTitle.innerText = `${uiText.popupAlbumTitle}: ${title}`;
            refs.popupEntityImage.src = resolveCoverUrl(album.meta.coverUri, coverSize);
            refs.popupEntityMeta.innerHTML = `${uiText.popupPlaylistMetaCount}: ${trackIds.length}`;

            refs.popupEntityDownloadButton.hidden = false;
            setPlaylistDownloadButton(refs.popupEntityDownloadButton, uiText.popupDownloadAlbum, `${trackIds.length}`);
            refs.popupEntityDownloadButton.onclick = () => {
                eventHandlers.downloadTracks(appYaTabId, trackIds, `album/${escapeFileName(title)}`);
            };

            return;
        }

        if (chart && chart?.tracksSubPage?.items?.length) {
            const trackIds = chart.tracksSubPage.items.map((track) => track.id);
            refs.popupEntityTitle.innerText = uiText.popupDownloadChart;
            refs.popupEntityMeta.innerHTML = `${uiText.popupPlaylistMetaCount}: ${trackIds.length}`;

            refs.popupEntityDownloadButton.hidden = false;
            setPlaylistDownloadButton(refs.popupEntityDownloadButton, uiText.popupDownloadChart, `${trackIds.length}`);
            refs.popupEntityDownloadButton.onclick = () => {
                eventHandlers.downloadTracks(appYaTabId, trackIds, 'chart');
            };

            return;
        }

        refs.popupGrid.classList.add('popup-grid--single');
        refs.popupTrackColumn.classList.add('popup-column--full');
        refs.popupEntityColumn.hidden = true;
    },

    getTokenExpirationDate(tokenData) {
        const currentTime = Date.now();
        const expiresInMillis = tokenData.expires_in * 1000;
        const expirationDate = new Date(currentTime + expiresInMillis);
        const day = String(expirationDate.getDate()).padStart(2, '0');
        const month = String(expirationDate.getMonth() + 1).padStart(2, '0');
        const year = expirationDate.getFullYear();

        return `${day}.${month}.${year}`;
    }
};

const eventHandlers = {
    init() {
        document.addEventListener('DOMContentLoaded', this.onDOMContentLoaded);
        popupStopDownloadsButton?.addEventListener('click', this.stopDownloads);
    },

    onDOMContentLoaded() {
        storageService.getStorageData(async (result) => {
            const settings = normalizeSettings(result[APP_CONFIG.storageKeys.settings]);
            uiUpdater.applyTheme(settings.theme);
            uiUpdater.updateDownloadState(result[APP_CONFIG.storageKeys.downloadState]);

            storageService.monitorStorageChanges((changes) => {
                const databaseChange = changes[APP_CONFIG.storageKeys.database];
                const settingsChange = changes[APP_CONFIG.storageKeys.settings];
                const downloadStateChange = changes[APP_CONFIG.storageKeys.downloadState];

                if (settingsChange) {
                    window.location.reload();
                    return;
                }

                if (downloadStateChange) {
                    uiUpdater.updateDownloadState(downloadStateChange.newValue);
                }

                if (!databaseChange) {
                    return;
                }

                const {newValue, oldValue} = databaseChange;
                if (
                    newValue?.appYa_currentTrack !== oldValue?.appYa_currentTrack
                    || newValue?.appYa_cureitTrack !== oldValue?.appYa_cureitTrack
                    || newValue?.appYa_currentTrackId !== oldValue?.appYa_currentTrackId
                    || newValue?.appYa_previousTrack !== oldValue?.appYa_previousTrack
                    || newValue?.appYa_nextTrack !== oldValue?.appYa_nextTrack
                    || newValue?.appYa_nextTrackId !== oldValue?.appYa_nextTrackId
                    || newValue?.appYa_page !== oldValue?.appYa_page
                    || newValue?.appYa_token !== oldValue?.appYa_token
                ) {
                    logger.log('storage changed, reloading popup');
                    window.location.reload();
                }
            });

            const musicTabContext = await tabService.resolveMusicTabContext(result[APP_CONFIG.storageKeys.tabId]);
            if (
                typeof musicTabContext.tabId === 'number'
                && musicTabContext.tabId !== result[APP_CONFIG.storageKeys.tabId]
            ) {
                chrome.storage.local.set({[APP_CONFIG.storageKeys.tabId]: musicTabContext.tabId});
            }

            if (result[APP_CONFIG.storageKeys.database]) {
                uiUpdater.updateUI(
                    result[APP_CONFIG.storageKeys.database],
                    result[APP_CONFIG.storageKeys.tabId],
                    result,
                    musicTabContext
                );
            } else {
                const stateView = renderer.renderState(
                    uiText.popupMusicTabState,
                    musicTabContext.actionLabel
                );
                stateView.actionButton.onclick = () => eventHandlers.openOrActivateMusicTab(result[APP_CONFIG.storageKeys.tabId]);
                logger.warn('appYa_db not found in storage');
            }
        });
    },

    downloadTracks(tabId, trackIds, playlistName) {
        chrome.runtime.sendMessage({
            action: 'download_Tracks',
            tabId,
            trackIds,
            playlistName
        }, (response) => {
            if (chrome.runtime.lastError) {
                logger.error('download request failed', chrome.runtime.lastError.message);
            } else {
                logger.log('download request accepted', {
                    playlistName,
                    trackCount: trackIds.length,
                    response
                });
            }
        });
    },

    resolveTrackInfo(trackId, slot = 'current') {
        const normalizedTrackId = pickFirstTrackId(trackId);
        if (!normalizedTrackId || pendingTrackInfoRequestIds[slot] === normalizedTrackId) {
            return;
        }

        pendingTrackInfoRequestIds[slot] = normalizedTrackId;
        chrome.runtime.sendMessage({
            action: 'resolve_track_info',
            trackId: normalizedTrackId,
            slot
        }, (response) => {
            if (chrome.runtime.lastError) {
                pendingTrackInfoRequestIds[slot] = null;
                logger.error('resolve_track_info request failed', chrome.runtime.lastError.message);
            } else {
                logger.log('resolve_track_info request accepted', {slot, response});
            }
        });
    },

    async openOrActivateMusicTab(storedTabId) {
        try {
            const musicTabContext = await tabService.resolveMusicTabContext(storedTabId);
            window.close();

            if (typeof musicTabContext.tabId === 'number') {
                await tabService.updateTab(musicTabContext.tabId, {active: true});
                return;
            }

            await tabService.createTab({url: APP_CONFIG.yandex.locationOrigin});
        } catch (error) {
            logger.error('failed to open or activate music tab', error);
        }
    },

    stopDownloads() {
        chrome.runtime.sendMessage({action: 'stop_downloads'}, (response) => {
            if (chrome.runtime.lastError) {
                logger.error('stop_downloads request failed', chrome.runtime.lastError.message);
            } else {
                logger.log('stop_downloads request accepted', response);
            }
        });
    },

    changeTabUrl(tabId, url) {
        if (!url) {
            return;
        }

        window.close();

        if (typeof tabId !== 'number') {
            tabService.createTab({url}).catch((error) => {
                logger.error('failed to create music tab', error);
            });
            return;
        }

        chrome.tabs.update(tabId, {url}, () => {
            if (chrome.runtime.lastError) {
                logger.error('failed to change tab url', chrome.runtime.lastError);
            } else {
                logger.log('tab url changed', url);
            }
        });
    }
};

const parser = {
    parseStorage(data) {
        return Object.keys(data).reduce((acc, key) => {
            const value = data[key];
            try {
                if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
                    acc[key] = JSON.parse(value);
                } else {
                    acc[key] = value;
                }
            } catch (error) {
                logger.error(`Ошибка парсинга JSON для ключа ${key}:`, error);
                acc[key] = value;
            }
            return acc;
        }, {});
    }
};

if (hasPopupShell) {
    eventHandlers.init();
}
