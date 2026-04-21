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
const defaultCoverImage = chrome.runtime.getURL('icons/app-icon.png');

let pendingTrackInfoRequestId = null;

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
    ['popup-open-settings-button', popupOpenSettingsButton]
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

function resolveCoverUrl(coverUri, coverSize) {
    return coverUri ? `https://${coverUri.replace(/%%/g, coverSize)}` : defaultCoverImage;
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

function applyTrackPanelTheme(refs, derivedColors = {}) {
    const backgroundColor = derivedColors.accent || '';
    const computedTextColor = parseColor(derivedColors.waveText)
        ? derivedColors.waveText
        : getContrastingTextColor(backgroundColor);
    const isLightBackground = getContrastingTextColor(backgroundColor) === '#101217';

    refs.popupTrackPanel.style.backgroundColor = backgroundColor;
    refs.popupTrackPanel.style.setProperty('--popup-track-text', computedTextColor);
    refs.popupTrackPanel.style.setProperty(
        '--popup-track-muted',
        toAlphaColor(computedTextColor, isLightBackground ? 0.76 : 0.84)
    );
    refs.popupTrackPanel.style.setProperty(
        '--popup-track-button-bg',
        isLightBackground ? 'rgba(16, 18, 23, 0.92)' : 'rgba(248, 246, 242, 0.9)'
    );
    refs.popupTrackPanel.style.setProperty(
        '--popup-track-button-text',
        isLightBackground ? '#f8f6f2' : '#101217'
    );
    refs.popupTrackPanel.style.setProperty('--popup-track-button-border', 'transparent');
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

function resolveCurrentTrackId(parsedData) {
    return pickFirstTrackId(parsedData.appYa_currentTrackId)
        || extractTrackIdFromFileInfoPayload(parsedData['appYa_get-file-info'])
        || extractTrackIdFromPlaysPayload(parsedData.appYa_plays);
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
    renderState(message) {
        popupContentRoot.innerHTML = `
            <section class="popup-state">
                <p class="popup-state-text mb-0"></p>
            </section>
        `;

        const root = popupContentRoot.firstElementChild;
        root.querySelector('.popup-state-text').textContent = message;
        popupTokenMeta.hidden = true;
        return {root};
    },

    renderAuth(authorizeUrl, appYa_tabID) {
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
                chrome.tabs.remove(appYa_tabID, () => {
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

    renderWork() {
        popupContentRoot.innerHTML = `
            <div class="popup-work">
                <div class="popup-grid" id="popup-grid">
                    <section class="popup-column" id="popup-track-column">
                        <strong class="popup-section-title">${uiText.popupCurrentTrack}</strong>
                        <div id="popup-track-panel" class="popup-panel">
                            <img id="popup-track-image" src="${defaultCoverImage}" class="popup-image" alt="Track Image">
                            <div class="popup-panel-body">
                                <h5 id="popup-track-title" class="popup-track-title text-center"></h5>
                                <p id="popup-track-meta" class="popup-meta text-center mb-0"></p>
                                <div class="popup-actions d-grid gap-2">
                                    <button id="popup-track-download-button" type="button" class="btn btn-dark btn-sm"></button>
                                    <small id="popup-track-shortcuts" class="popup-hint text-center"></small>
                                </div>
                            </div>
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
            popupTrackPanel: root.querySelector('#popup-track-panel'),
            popupTrackImage: root.querySelector('#popup-track-image'),
            popupTrackTitle: root.querySelector('#popup-track-title'),
            popupTrackMeta: root.querySelector('#popup-track-meta'),
            popupTrackDownloadButton: root.querySelector('#popup-track-download-button'),
            popupTrackShortcuts: root.querySelector('#popup-track-shortcuts'),
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

        refs.popupTrackTitle.textContent = uiText.popupCurrentTrack;
        refs.popupTrackMeta.textContent = uiText.popupEmptyTrack;
        refs.popupTrackDownloadButton.textContent = uiText.parserButtonDefault;
        refs.popupTrackShortcuts.textContent = uiText.popupShortcuts;
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

    resetTrackInfo(refs) {
        refs.popupTrackPanel.style.backgroundColor = '';
        refs.popupTrackPanel.style.removeProperty('--popup-track-text');
        refs.popupTrackPanel.style.removeProperty('--popup-track-muted');
        refs.popupTrackPanel.style.removeProperty('--popup-track-button-bg');
        refs.popupTrackPanel.style.removeProperty('--popup-track-button-text');
        refs.popupTrackPanel.style.removeProperty('--popup-track-button-border');
        refs.popupTrackImage.src = defaultCoverImage;
        refs.popupTrackTitle.textContent = uiText.popupCurrentTrack;
        refs.popupTrackMeta.textContent = '';
        refs.popupTrackDownloadButton.disabled = true;
        refs.popupTrackDownloadButton.textContent = uiText.parserButtonDefault;
        refs.popupTrackDownloadButton.onclick = null;
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

    updateTokenInfo(tokenData, appYa_tabID) {
        popupTokenMeta.hidden = false;
        popupTokenEnd.textContent = this.getTokenExpirationDate(tokenData);
        popupTokenRefreshButton.onclick = async function (event) {
            event.preventDefault();
            await chrome.storage.local.remove(APP_CONFIG.storageKeys.database);
            chrome.scripting.executeScript({
                target: {tabId: appYa_tabID},
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
                world: "MAIN",
            }, () => {
                window.close();
            });
        };
    },

    updateUI(data, appYa_tabID, app) {
        const parsedData = parser.parseStorage(data);
        const settings = normalizeSettings(app?.[APP_CONFIG.storageKeys.settings]);
        const coverQuality = settings.coverQuality ?? APP_CONFIG.defaults.coverQuality;
        const coverSize = `${coverQuality}x${coverQuality}`;

        this.applyTheme(settings.theme);
        logger.log('updateUI called', {
            tabId: appYa_tabID,
            coverSize,
            hasToken: Boolean(parsedData.appYa_token),
            hasPage: Boolean(parsedData.appYa_page)
        });

        if (!parsedData.appYa_token) {
            renderer.renderAuth(parsedData.appYa_authorizationUrl, appYa_tabID);
            return;
        }

        this.updateTokenInfo(parsedData.appYa_token, appYa_tabID);
        const refs = renderer.renderWork();
        this.updateTrackInfo(parsedData, appYa_tabID, coverSize, refs);
        this.updatePlaylistInfo(parsedData, appYa_tabID, coverSize, refs);
    },

    updateTrackInfo(parsedData, appYa_tabID, coverSize, refs) {
        this.resetTrackInfo(refs);

        const expectedTrackId = resolveCurrentTrackId(parsedData);
        const cachedTrackId = pickFirstTrackId(parsedData.appYa_cureitTrack?.trackinfo?.id);
        const hasFreshTrackInfo = Boolean(
            parsedData.appYa_cureitTrack
            && (!expectedTrackId || !cachedTrackId || expectedTrackId === cachedTrackId)
        );

        if (!hasFreshTrackInfo) {
            if (expectedTrackId) {
                refs.popupTrackTitle.textContent = uiText.popupResolvingTrack;
                refs.popupTrackMeta.textContent = '';
                eventHandlers.resolveTrackInfo(expectedTrackId);
                logger.log('popup requested current track info', {trackId: expectedTrackId});
            } else {
                refs.popupTrackTitle.textContent = uiText.popupEmptyTrack;
                refs.popupTrackMeta.textContent = uiText.popupEmptyState;
                logger.warn('track info is missing for popup');
            }
            return;
        }

        pendingTrackInfoRequestId = null;

        const track = parsedData.appYa_cureitTrack.trackinfo;
        const imageURL = resolveCoverUrl(track.coverUri, coverSize);
        const artists = track.artists.map((item) => item.name).join(', ');
        const albums = track.albums.map((item) => item.year).join(', ');

        refs.popupTrackTitle.innerText = track.title;
        refs.popupTrackMeta.innerHTML = `${artists}<br>${albums}`;
        refs.popupTrackImage.src = imageURL;
        applyTrackPanelTheme(refs, track.derivedColors);
        refs.popupTrackDownloadButton.disabled = false;
        refs.popupTrackDownloadButton.onclick = () => {
            eventHandlers.downloadTracks(appYa_tabID, [track.id], 'music');
        };

        logger.log('rendering current track', {
            trackId: track.id,
            title: track.title,
            artists
        });
    },

    updatePlaylistInfo(parsedData, appYa_tabID, coverSize, refs) {
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

                eventHandlers.downloadTracks(appYa_tabID, idsToDownload, `playlist/${title}`);
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
                eventHandlers.downloadTracks(appYa_tabID, trackIds, `artist/${escapeFileName(title)}`);
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
                    eventHandlers.changeTabUrl(appYa_tabID, link.getAttribute('data-url-tab'));
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
                eventHandlers.downloadTracks(appYa_tabID, trackIds, `album/${escapeFileName(title)}`);
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
                eventHandlers.downloadTracks(appYa_tabID, trackIds, 'chart');
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
    },

    onDOMContentLoaded() {
        storageService.getStorageData((result) => {
            const settings = normalizeSettings(result[APP_CONFIG.storageKeys.settings]);
            uiUpdater.applyTheme(settings.theme);

            storageService.monitorStorageChanges((changes) => {
                const databaseChange = changes[APP_CONFIG.storageKeys.database];
                const settingsChange = changes[APP_CONFIG.storageKeys.settings];

                if (settingsChange) {
                    window.location.reload();
                    return;
                }

                if (!databaseChange) {
                    return;
                }

                const {newValue, oldValue} = databaseChange;
                if (
                    newValue?.appYa_cureitTrack !== oldValue?.appYa_cureitTrack
                    || newValue?.appYa_page !== oldValue?.appYa_page
                    || newValue?.appYa_currentTrackId !== oldValue?.appYa_currentTrackId
                    || newValue?.appYa_token !== oldValue?.appYa_token
                ) {
                    logger.log('storage changed, reloading popup');
                    window.location.reload();
                }
            });

            if (result[APP_CONFIG.storageKeys.database]) {
                uiUpdater.updateUI(
                    result[APP_CONFIG.storageKeys.database],
                    result[APP_CONFIG.storageKeys.tabId],
                    result
                );
            } else {
                renderer.renderState(uiText.popupEmptyState);
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

    resolveTrackInfo(trackId) {
        const normalizedTrackId = pickFirstTrackId(trackId);
        if (!normalizedTrackId || pendingTrackInfoRequestId === normalizedTrackId) {
            return;
        }

        pendingTrackInfoRequestId = normalizedTrackId;
        chrome.runtime.sendMessage({
            action: 'resolve_track_info',
            trackId: normalizedTrackId
        }, (response) => {
            if (chrome.runtime.lastError) {
                pendingTrackInfoRequestId = null;
                logger.error('resolve_track_info request failed', chrome.runtime.lastError.message);
            } else {
                logger.log('resolve_track_info request accepted', response);
            }
        });
    },

    changeTabUrl(tabId, url) {
        if (!url) {
            return;
        }

        window.close();
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
