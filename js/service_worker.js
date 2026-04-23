/**
 * Service worker координирует внедрение page-script, синхронизацию состояния
 * и скачивание треков с упаковкой метаданных.
 */
if (typeof importScripts === 'function') {
    importScripts('config.js', '../html/bs5/browser-id3-writer.6.0.0.mjs');
}

const extensionAction = chrome.action ?? chrome.browserAction ?? null;
const logger = createDebugLogger('worker');

logger.log('service_worker.js loaded');

function parseStoredJson(value) {
    if (!value) {
        return null;
    }

    if (typeof value !== 'string') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return null;
    }
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
        || pickFirstTrackId(payload.result?.downloadInfo?.trackId)
        || pickFirstTrackId(payload.downloadInfo?.trackId)
        || pickFirstTrackId(payload.result?.trackId)
        || pickFirstTrackId(payload.result?.trackIds);

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

function mergeDatabaseState(existingDb = {}, incomingData = {}) {
    const mergedDb = {
        ...incomingData
    };

    const keysToPreserve = [
        'appYa_currentTrack',
        'appYa_cureitTrack',
        'appYa_currentTrackId',
        'appYa_previousTrack',
        'appYa_nextTrack',
        'appYa_nextTrackId'
    ];

    keysToPreserve.forEach((key) => {
        if (!mergedDb[key] && existingDb[key]) {
            mergedDb[key] = existingDb[key];
        }
    });

    if (!mergedDb.appYa_currentTrack && mergedDb.appYa_cureitTrack) {
        mergedDb.appYa_currentTrack = mergedDb.appYa_cureitTrack;
    }

    if (!mergedDb.appYa_cureitTrack && mergedDb.appYa_currentTrack) {
        mergedDb.appYa_cureitTrack = mergedDb.appYa_currentTrack;
    }

    const currentTrackId = pickFirstTrackId(mergedDb.appYa_currentTrackId);
    const nextTrackId = pickFirstTrackId(mergedDb.appYa_nextTrackId);
    if (currentTrackId && nextTrackId && currentTrackId === nextTrackId) {
        mergedDb.appYa_nextTrackId = '';
        mergedDb.appYa_nextTrack = '';
    }

    return mergedDb;
}

const appService = {
    /**
     * Сохраняет значение в `chrome.storage.local`.
     * @param {string} key Ключ storage.
     * @param {*} value Значение для сохранения.
     * @returns {Promise<void>}
     */
    saveToStorage(key, value) {
        return chrome.storage.local.set({[key]: value});
    },

    /**
     * Получает значение из `chrome.storage.local`.
     * @param {string} key Ключ storage.
     * @returns {Promise<object>} Объект результата чтения.
     */
    getFromStorage(key) {
        return chrome.storage.local.get(key);
    }
};

/**
 * Управляет состоянием badge расширения во время пакетных загрузок.
 */
const badgeManager = {
    colors: [...APP_CONFIG.badgeColors],
    usedColors: [],

    /**
     * Сбрасывает список уже использованных цветов.
     * @returns {void}
     */
    resetColors() {
        this.usedColors = [];
    },

    /**
     * Возвращает случайный ещё не использованный цвет badge.
     * @returns {string} Цвет в hex-формате.
     */
    getRandomColor() {
        if (this.usedColors.length === this.colors.length) {
            this.resetColors();
        }
        const availableColors = this.colors.filter(color => !this.usedColors.includes(color));
        const randomColor = availableColors[Math.floor(Math.random() * availableColors.length)];
        this.usedColors.push(randomColor);
        return randomColor;
    },

    /**
     * Обновляет текст и цвет badge расширения.
     * @param {number} count Текущее количество активных загрузок.
     * @param {string} bg Цвет фона badge.
     * @returns {void}
     */
    updateBadge(count, bg) {
        if (!extensionAction) {
            return;
        }

        extensionAction.setBadgeText({text: count > 0 ? count.toString() : ""});
        extensionAction.setBadgeBackgroundColor({color: bg});
    }
};

/**
 * Инкапсулирует загрузку треков, упаковку ID3-метаданных и сохранение файлов.
 */
const downloadManager = {
    queueState: {
        totalCount: 0,
        queuedCount: 0,
        stopRequested: false,
        activeDownloadIds: new Set(),
        badgeColor: null
    },

    createQueueState() {
        return {
            totalCount: 0,
            queuedCount: 0,
            stopRequested: false,
            activeDownloadIds: new Set(),
            badgeColor: null
        };
    },

    getQueueSnapshot() {
        const activeDownloadCount = this.queueState.activeDownloadIds.size;
        const remainingCount = this.queueState.queuedCount + activeDownloadCount;

        return {
            isActive: remainingCount > 0,
            stopRequested: this.queueState.stopRequested,
            totalCount: this.queueState.totalCount,
            remainingCount,
            activeDownloadCount,
            completedCount: Math.max(this.queueState.totalCount - remainingCount, 0)
        };
    },

    async persistQueueState() {
        const snapshot = this.getQueueSnapshot();
        const badgeColor = this.queueState.badgeColor || badgeManager.getRandomColor();

        badgeManager.updateBadge(snapshot.remainingCount, badgeColor);
        await chrome.storage.local.set({
            [APP_CONFIG.storageKeys.downloadState]: snapshot
        });

        if (!snapshot.isActive) {
            this.queueState = this.createQueueState();
            badgeManager.updateBadge(0, badgeColor);
        }

        return snapshot;
    },

    async startQueue(trackCount) {
        const previousSnapshot = this.getQueueSnapshot();
        if (!previousSnapshot.isActive) {
            this.queueState = this.createQueueState();
            this.queueState.badgeColor = badgeManager.getRandomColor();
        }

        this.queueState.totalCount += trackCount;
        this.queueState.queuedCount += trackCount;
        this.queueState.stopRequested = false;
        return this.persistQueueState();
    },

    async completeQueuedTrack() {
        if (this.queueState.queuedCount > 0) {
            this.queueState.queuedCount -= 1;
        }

        return this.persistQueueState();
    },

    async discardQueuedTracks(count) {
        if (count <= 0) {
            return this.getQueueSnapshot();
        }

        this.queueState.queuedCount = Math.max(0, this.queueState.queuedCount - count);
        return this.persistQueueState();
    },

    async handoffQueuedTrackToBrowser(downloadId) {
        if (this.queueState.queuedCount > 0) {
            this.queueState.queuedCount -= 1;
        }

        if (typeof downloadId === 'number') {
            this.queueState.activeDownloadIds.add(downloadId);
        }

        return this.persistQueueState();
    },

    async finalizeBrowserDownload(downloadId) {
        if (typeof downloadId === 'number') {
            this.queueState.activeDownloadIds.delete(downloadId);
        }

        return this.persistQueueState();
    },

    shouldStopQueue() {
        return Boolean(this.queueState.stopRequested);
    },

    revokeDownloadUrlIfNeeded(inputData) {
        if (typeof inputData?.download === 'string' && inputData.download.startsWith('blob:')) {
            URL.revokeObjectURL(inputData.download);
        }
    },

    async requestStop() {
        const snapshot = this.getQueueSnapshot();
        if (!snapshot.isActive) {
            return snapshot;
        }

        this.queueState.stopRequested = true;
        await this.persistQueueState();

        const activeDownloadIds = [...this.queueState.activeDownloadIds];
        await Promise.all(activeDownloadIds.map((downloadId) => new Promise((resolve) => {
            chrome.downloads.cancel(downloadId, () => {
                if (chrome.runtime.lastError) {
                    logger.warn('chrome.downloads.cancel failed', {
                        downloadId,
                        message: chrome.runtime.lastError.message
                    });
                }
                resolve();
            });
        })));

        return this.getQueueSnapshot();
    },

    /**
     * Повторяет сетевой запрос несколько раз, если он завершился ошибкой.
     * @param {string} url URL запроса.
     * @param {RequestInit|undefined} options Параметры fetch.
     * @param {string} requestName Имя запроса для логов.
     * @param {number} [attempts=2] Количество попыток.
     * @returns {Promise<Response>} Ответ fetch.
     */
    async fetchWithRetry(url, options, requestName, attempts = 2) {
        let lastError = null;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            try {
                if (attempt > 1) {
                    logger.warn('retrying worker request', {requestName, attempt, url});
                }

                return await fetch(url, options);
            } catch (error) {
                lastError = error;
                logger.warn('worker request failed', {
                    requestName,
                    attempt,
                    url,
                    message: error?.message || String(error)
                });
            }
        }

        throw lastError;
    },

    /**
     * Читает OAuth-токен Яндекс Музыки из сохранённой базы расширения.
     * @returns {Promise<object>} Данные токена.
     */
    async getStoredTokenData() {
        const dbResult = await chrome.storage.local.get(APP_CONFIG.storageKeys.database);
        const appYaDb = dbResult[APP_CONFIG.storageKeys.database];
        const rawToken = appYaDb?.appYa_token;

        if (!rawToken) {
            throw new Error('Yandex token is missing in storage');
        }

        return typeof rawToken === 'string' ? JSON.parse(rawToken) : rawToken;
    },

    /**
     * Строит набор HTTP-заголовков для запросов к API Яндекс Музыки.
     * @param {{access_token: string}} tokenData OAuth-токен.
     * @returns {Headers} Заголовки запроса.
     */
    buildHeaders(tokenData) {
        return new Headers({
            'Authorization': `OAuth ${tokenData.access_token}`,
            'X-Yandex-Music-Client': APP_CONFIG.yandex.desktopClientHeader
        });
    },

    /**
     * Загружает необязательный бинарный ресурс, например обложку или аватар артиста.
     * @param {string|null} url URL ресурса.
     * @param {string} requestName Имя запроса для логов.
     * @returns {Promise<Uint8Array|null>} Бинарные данные или `null`.
     */
    async fetchOptionalBinary(url, requestName) {
        if (!url) {
            return null;
        }

        try {
            const response = await this.fetchWithRetry(url, undefined, requestName, 1);
            if (!response.ok) {
                logger.warn('optional binary fetch not ok', {
                    requestName,
                    status: response.status,
                    url
                });
                return null;
            }
            return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
            logger.warn('optional binary fetch failed', {
                requestName,
                url,
                message: error?.message || String(error)
            });
            return null;
        }
    },

    /**
     * Получает только метаданные трека без подготовки аудиофайла.
     * @param {number|string} trackId Идентификатор трека.
     * @returns {Promise<object>} Метаданные трека.
     */
    async fetchTrackMetadata(trackId) {
        const tokenData = await this.getStoredTokenData();
        const headers = this.buildHeaders(tokenData);
        const trackInfoUrl = `${APP_CONFIG.yandex.apiUrl}tracks?trackIds=${trackId}`;
        const response = await this.fetchWithRetry(trackInfoUrl, {headers}, 'worker-track-metadata');

        if (!response.ok) {
            throw new Error(`worker-track-metadata bad status ${response.status}`);
        }

        const data = await response.json();
        const trackInfo = data?.result?.[0];

        if (!trackInfo) {
            throw new Error(`track metadata is missing for track ${trackId}`);
        }

        return trackInfo;
    },

    /**
     * Получает ссылку на аудио, метаданные трека и по возможности упаковывает ID3-теги.
     * @param {number|string} trackId Идентификатор трека.
     * @param {object} settings Нормализованные настройки скачивания.
     * @returns {Promise<{download: string, trackinfo: object}>} Подготовленный пакет для скачивания.
     */
    async fetchTrackPackage(trackId, settings) {
        const tokenData = await this.getStoredTokenData();
        const timestamp = Math.floor(Date.now() / 1000);
        const quality = settings.audioQuality || APP_CONFIG.defaults.audioQuality;
        const dataToSign = `${timestamp}${trackId}${quality}flacraw`;
        const sign = await this.generateSign(APP_CONFIG.yandex.signingSecret, dataToSign);
        const headers = this.buildHeaders(tokenData);

        const params = new URLSearchParams({
            ts: timestamp,
            trackId: String(trackId),
            quality: quality,
            codecs: 'flac',
            transports: 'raw',
            sign: sign
        });

        const fileInfoUrl = `${APP_CONFIG.yandex.apiUrl}get-file-info?${params.toString()}`;
        const trackInfoUrl = `${APP_CONFIG.yandex.apiUrl}tracks?trackIds=${trackId}`;

        const [fileInfoResponse, trackInfoResponse] = await Promise.all([
            this.fetchWithRetry(fileInfoUrl, {headers}, 'worker-get-file-info'),
            this.fetchWithRetry(trackInfoUrl, {headers}, 'worker-track-info')
        ]);

        if (!fileInfoResponse.ok) {
            throw new Error(`worker-get-file-info bad status ${fileInfoResponse.status}`);
        }
        if (!trackInfoResponse.ok) {
            throw new Error(`worker-track-info bad status ${trackInfoResponse.status}`);
        }

        const fileInfoData = await fileInfoResponse.json();
        const trackInfoData = await trackInfoResponse.json();
        const downloadUrl = fileInfoData?.result?.downloadInfo?.url;
        const trackInfo = trackInfoData?.result?.[0];

        if (!downloadUrl || !trackInfo) {
            throw new Error(`track package is incomplete for track ${trackId}`);
        }

        try {
            const audioResponse = await this.fetchWithRetry(downloadUrl, undefined, 'worker-download-audio');
            if (!audioResponse.ok) {
                throw new Error(`worker-download-audio bad status ${audioResponse.status}`);
            }

            const audioArrayBuffer = await audioResponse.arrayBuffer();
            const coverQuality = String(settings.coverQuality || APP_CONFIG.defaults.coverQuality);
            const coverSize = `${coverQuality}x${coverQuality}`;
            const coverUrl = trackInfo.albums?.[0]?.coverUri ? `https://${trackInfo.albums[0].coverUri.replace('%%', coverSize)}` : null;
            const artistUrl = trackInfo.artists?.[0]?.cover?.uri ? `https://${trackInfo.artists[0].cover.uri.replace('%%', coverSize)}` : null;

            const [coverData, artistCoverData] = await Promise.all([
                this.fetchOptionalBinary(coverUrl, 'worker-download-cover'),
                this.fetchOptionalBinary(artistUrl, 'worker-download-artist-cover')
            ]);

            if (typeof ID3Writer !== 'function') {
                throw new Error('ID3Writer is unavailable in service worker');
            }

            const writer = new ID3Writer(audioArrayBuffer);
            const currentTrackNumber = trackInfo.albums?.[0]?.trackPosition?.index || '1';
            const totalTracksInAlbum = trackInfo.albums?.[0]?.trackCount || '1';

            writer
                .setFrame('TIT2', trackInfo.title)
                .setFrame('TPE1', [trackInfo.artists.map((artist) => artist.name).join(', ')])
                .setFrame('TALB', trackInfo.albums?.[0]?.title || '')
                .setFrame('TYER', trackInfo.albums?.[0]?.year || '')
                .setFrame('TCON', trackInfo.albums?.[0]?.genre?.split(',') || ['Unknown'])
                .setFrame('TRCK', `${currentTrackNumber}/${totalTracksInAlbum}`);

            if (coverData) {
                writer.setFrame('APIC', {
                    type: 3,
                    data: coverData,
                    description: 'Cover (front)'
                });
            }

            if (artistCoverData) {
                writer.setFrame('APIC', {
                    type: 17,
                    data: artistCoverData,
                    description: 'Band Logo'
                });
            }

            writer.addTag();

            return {
                download: URL.createObjectURL(new Blob([writer.arrayBuffer], {type: 'audio/mpeg'})),
                trackinfo: trackInfo
            };
        } catch (error) {
            logger.warn('metadata packaging failed, falling back to direct download url', {
                trackId,
                message: error?.message || String(error)
            });

            return {
                download: downloadUrl,
                trackinfo: trackInfo
            };
        }
    },

    /**
     * Формирует обновление storage для текущего или следующего трека.
     * @param {object} appYaDb Текущая база extension storage.
     * @param {number|string} trackId Идентификатор трека.
     * @param {object} trackInfo Метаданные трека.
     * @param {'current'|'next'} slot Целевой слот в popup.
     * @returns {object} Новый объект базы для сохранения.
     */
    buildResolvedTrackState(appYaDb, trackId, trackInfo, slot = 'current') {
        const normalizedTrackId = String(trackId);
        const currentTrackId = pickFirstTrackId(appYaDb.appYa_currentTrackId);
        const nextTrackId = pickFirstTrackId(appYaDb.appYa_nextTrackId);
        const trackPayload = JSON.stringify({trackinfo: trackInfo});
        const nextState = {
            ...appYaDb
        };

        if (slot === 'next') {
            if (normalizedTrackId === currentTrackId) {
                nextState.appYa_nextTrackId = '';
                nextState.appYa_nextTrack = '';
                return nextState;
            }

            nextState.appYa_nextTrackId = normalizedTrackId;
            nextState.appYa_nextTrack = trackPayload;
            return nextState;
        }

        nextState.appYa_currentTrackId = normalizedTrackId;
        nextState.appYa_currentTrack = trackPayload;
        nextState.appYa_cureitTrack = trackPayload;

        if (normalizedTrackId === nextTrackId) {
            nextState.appYa_nextTrackId = '';
            nextState.appYa_nextTrack = '';
        }

        return nextState;
    },

    /**
     * Сохраняет ожидаемый идентификатор трека в нужный слот до получения метаданных.
     * Это позволяет popup сразу понять, что текущий трек сменился, даже если запрос
     * к API ещё не завершился.
     * @param {object} appYaDb Текущее состояние базы.
     * @param {number|string} trackId Идентификатор трека.
     * @param {'current'|'next'} slot Целевой слот.
     * @returns {object} Новый объект базы для сохранения.
     */
    buildPendingTrackState(appYaDb, trackId, slot = 'current') {
        const normalizedTrackId = String(trackId);
        const nextState = {
            ...appYaDb
        };

        if (slot === 'next') {
            const currentTrackId = pickFirstTrackId(appYaDb.appYa_currentTrackId);
            if (normalizedTrackId === currentTrackId) {
                nextState.appYa_nextTrackId = '';
                nextState.appYa_nextTrack = '';
                return nextState;
            }

            nextState.appYa_nextTrackId = normalizedTrackId;
            return nextState;
        }

        nextState.appYa_currentTrackId = normalizedTrackId;

        if (normalizedTrackId === pickFirstTrackId(appYaDb.appYa_nextTrackId)) {
            nextState.appYa_nextTrackId = '';
            nextState.appYa_nextTrack = '';
        }

        return nextState;
    },

    /**
     * Обновляет данные о текущем или следующем треке в storage, чтобы popup мог их показать.
     * @param {number|string} trackId Идентификатор трека.
     * @param {'current'|'next'} slot Целевой слот.
     * @returns {Promise<void>}
     */
    async resolveTrackInfo(trackId, slot = 'current') {
        try {
            const dbResult = await chrome.storage.local.get(APP_CONFIG.storageKeys.database);
            const appYaDb = dbResult[APP_CONFIG.storageKeys.database] || {};
            const pendingDbState = this.buildPendingTrackState(appYaDb, trackId, slot);

            await chrome.storage.local.set({
                [APP_CONFIG.storageKeys.database]: pendingDbState
            });

            const trackInfo = await this.fetchTrackMetadata(trackId);
            const latestDbResult = await chrome.storage.local.get(APP_CONFIG.storageKeys.database);
            const latestDb = latestDbResult[APP_CONFIG.storageKeys.database] || {};
            const expectedTrackId = slot === 'next'
                ? pickFirstTrackId(latestDb.appYa_nextTrackId)
                : pickFirstTrackId(latestDb.appYa_currentTrackId);
            const normalizedTrackId = String(trackId);

            if (expectedTrackId !== normalizedTrackId) {
                logger.warn('track info resolution discarded because slot moved on', {
                    slot,
                    resolvedTrackId: normalizedTrackId,
                    expectedTrackId
                });
                return;
            }

            const nextDbState = this.buildResolvedTrackState(latestDb, trackId, trackInfo, slot);

            await chrome.storage.local.set({
                [APP_CONFIG.storageKeys.database]: nextDbState
            });

            logger.log('track info resolved in worker', {
                slot,
                trackId,
                title: trackInfo?.title
            });
        } catch (error) {
            logger.error('resolveTrackInfo failed', {trackId, slot, error});
        }
    },

    /**
     * Генерирует HMAC-подпись для запроса к API Яндекс Музыки.
     * @param {string} secretKey Секретный ключ.
     * @param {string} data Данные для подписи.
     * @returns {Promise<string>} Base64-подпись без `=`.
     */
    async generateSign(secretKey, data) {
        const encoder = new TextEncoder();
        const keyData = encoder.encode(secretKey);
        const cryptoKey = await crypto.subtle.importKey(
            'raw',
            keyData,
            {name: 'HMAC', hash: {name: 'SHA-256'}},
            false,
            ['sign']
        );
        const dataEncoded = encoder.encode(data);
        const signature = await crypto.subtle.sign('HMAC', cryptoKey, dataEncoded);
        return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/=+$/, '');
    },

    /**
     * Запускает пакетное скачивание списка треков с учётом настроек пользователя.
     * @param {{tabId:number, playlistName:string, trackIds:number[]}} message Полезная нагрузка runtime-сообщения.
     * @returns {Promise<void>}
     */
    async downloadTracks(message) {
        let {tabId, playlistName, trackIds} = message;
        logger.log('downloadTracks called', {tabId, playlistName, trackIds});

        if (!Array.isArray(trackIds) || trackIds.length === 0) {
            logger.warn('downloadTracks skipped because trackIds are empty');
            return;
        }

        await this.startQueue(trackIds.length);

        const settingsResult = await chrome.storage.local.get(APP_CONFIG.storageKeys.settings);
        const appSettings = normalizeSettings(settingsResult[APP_CONFIG.storageKeys.settings]);
        const settings = {[APP_CONFIG.storageKeys.settings]: appSettings};

        const downloadFolder = appSettings.downloadFolder || 'music';
        playlistName = downloadFolder + '/' + playlistName;

        // Проверяем, содержит ли downloadFolder переменные
        const hasVariables = /%[^%]+%/.test(downloadFolder);

        let batchSize = appSettings.downlodadCount ?? APP_CONFIG.defaults.downlodadCount;
        logger.log('download batch prepared', {
            batchSize,
            totalTracks: trackIds.length,
            hasVariables
        });

        for (let i = 0; i < trackIds.length; i += batchSize) {
            const batch = trackIds.slice(i, i + batchSize);

            await Promise.all(batch.map(trackId =>
                (async () => {
                    if (this.shouldStopQueue()) {
                        await this.completeQueuedTrack();
                        logger.warn('track download skipped because stop was requested', {trackId});
                        return;
                    }

                    try {
                        const inputData = await this.fetchTrackPackage(trackId, appSettings);

                        if (this.shouldStopQueue()) {
                            this.revokeDownloadUrlIfNeeded(inputData);
                            await this.completeQueuedTrack();
                            logger.warn('prepared track discarded because stop was requested', {trackId});
                            return;
                        }

                        if (inputData !== null && inputData.download) {
                            logger.log('track data received in worker', {
                                trackId,
                                title: inputData.trackinfo?.title,
                                album: inputData.trackinfo?.albums?.[0]?.title
                            });

                            let effectivePlaylistName = playlistName;

                            if (hasVariables) {
                                let artists = inputData.trackinfo.artists.map((item) => item.name).join(', ');
                                const defaultTrackInfo = {
                                    dir: playlistName,
                                    genre: inputData.trackinfo.albums[0].genre || 'Unknown',
                                    year: inputData.trackinfo.albums[0].year || new Date().getFullYear(),
                                    artist: artists || 'Unknown Artist',
                                    album: inputData.trackinfo.albums[0].title || 'Unknown Album'
                                };

                                const variables = {
                                    '%dir%': playlistName,
                                    '%genre%': defaultTrackInfo.genre,
                                    '%year%': defaultTrackInfo.year.toString(),
                                    '%artist%': defaultTrackInfo.artist,
                                    '%album%': defaultTrackInfo.album
                                };

                                let processedFolder = downloadFolder;

                                for (const [variable, value] of Object.entries(variables)) {
                                    if (downloadFolder.includes(variable)) {
                                        const cleanValue = value.toString().replace(/[<>:"/\\|?*]/g, '_');
                                        processedFolder = processedFolder.replace(new RegExp(variable.replace(/%/g, '\\%'), 'gi'), cleanValue);
                                    }
                                }

                                effectivePlaylistName = processedFolder;
                                logger.log('download folder processed', {trackId, processedFolder});
                            }

                            await this.downloadFile(inputData, effectivePlaylistName, settings);
                        } else {
                            await this.completeQueuedTrack();
                            logger.warn('track data is empty or missing download url', {trackId});
                        }
                    } catch (error) {
                        await this.completeQueuedTrack();
                        logger.error('worker track package failed', {trackId, error});
                    }
                })()
            ));

            if (this.shouldStopQueue()) {
                const remainingTrackCount = Math.max(0, trackIds.length - (i + batch.length));
                await this.discardQueuedTracks(remainingTrackCount);
                break;
            }
        }
    },

    /**
     * Создаёт задание в менеджере загрузок браузера.
     * @param {{download: string, trackinfo: object}} inputData Данные для сохранения файла.
     * @param {string} playlistName Папка назначения.
     * @param {{app_setting: object}} settings Объект настроек для скачивания.
     * @returns {Promise<boolean>} `true`, если задача была передана браузеру.
     */
    downloadFile(inputData, playlistName, settings) {
        const escapeFileName = (fileName) => fileName.replace(/[\\/:*?"<>|]/g, '_');
        const artists = inputData.trackinfo.artists.map((item) => item.name).join(', ');
        const title = inputData.trackinfo.title;

        let trackPrefix = '';
        if (settings?.app_setting?.numberingTracks === true) {
            const trackIdx = inputData.trackinfo?.albums?.[0]?.trackPosition?.index;
            trackPrefix = trackIdx
                ? trackIdx.toString().padStart(2, '0') + '. '
                : '';
        }
        const fileName = `${playlistName}/${trackPrefix}${escapeFileName(artists)} - ${escapeFileName(title)}.mp3`;

        logger.log('downloadFile prepared', {fileName});

        return new Promise((resolve) => {
            chrome.downloads.download({
                url: inputData.download,
                filename: fileName,
                saveAs: false,
                conflictAction: 'overwrite'
            }, async (downloadId) => {
                if (chrome.runtime.lastError || typeof downloadId !== 'number') {
                    logger.error('chrome.downloads.download failed', chrome.runtime.lastError?.message || 'unknown error');
                    this.revokeDownloadUrlIfNeeded(inputData);
                    await this.completeQueuedTrack();
                    resolve(false);
                    return;
                }

                logger.log('download started', {downloadId, fileName});

                const removeFromHistory = settings?.app_setting.savehistory === '0'
                    || settings?.app_setting.savehistory === 0;

                const finalizeDownload = async (finalState) => {
                    if (removeFromHistory && finalState === 'complete') {
                        chrome.downloads.erase({id: downloadId}, () => {
                            if (chrome.runtime.lastError) {
                                logger.warn('download erase failed', chrome.runtime.lastError.message);
                            } else {
                                logger.log('download removed from history', {downloadId});
                            }
                        });
                    }

                    this.revokeDownloadUrlIfNeeded(inputData);
                    await this.finalizeBrowserDownload(downloadId);
                };

                const listener = (delta) => {
                    if (delta.id !== downloadId || !delta.state) {
                        return;
                    }

                    const currentState = delta.state.current;
                    if (currentState === 'in_progress') {
                        return;
                    }

                    chrome.downloads.onChanged.removeListener(listener);
                    void finalizeDownload(currentState);
                };

                chrome.downloads.onChanged.addListener(listener);
                await this.handoffQueuedTrackToBrowser(downloadId);
                resolve(true);
            });
        });
    }
};


/**
 * Runtime-обработчик сообщений от content script и popup.
 */
const worker = {
    /**
     * Маршрутизирует runtime-сообщения по действиям расширения.
     * @param {object} message Входящее сообщение.
     * @param {chrome.runtime.MessageSender} sender Отправитель сообщения.
     * @param {Function} sendResponse Функция ответа.
     * @returns {boolean|undefined} `true`, если ответ будет асинхронным.
     */
    onMessage(message, sender, sendResponse) {
        if (message.action === "inject_parser") {
            const tabId = sender.tab?.id;

            if (typeof tabId !== 'number') {
                sendResponse({success: false, message: 'Active tab is missing for parser injection'});
                return;
            }

            logger.log('inject_parser message received', {tabId});
            sendResponse({success: true, message: 'parser.js OK', tabId});
            chrome.scripting.executeScript({
                target: {tabId},
                files: ["js/config.js", "html/bs5/browser-id3-writer.6.0.0.mjs", "js/parser.js"],
                world: "MAIN"
            }).then(() => {
                chrome.scripting.executeScript({
                    target: {tabId},
                    func: () => {
                        if (typeof appYa !== 'undefined' && typeof appYa.init === 'function') {
                            appYa.init();
                        }
                    },
                    world: "MAIN"
                }).then(() => {
                    appService.saveToStorage(APP_CONFIG.storageKeys.tabId, tabId);
                    logger.log('parser injected and tab saved', {tabId});
                }).catch(console.error);
            }).catch(console.error);

            return;
        }

        if (message.action === "send_localStorage") {
            logger.log('send_localStorage message received', {
                keys: message.data ? Object.keys(message.data) : []
            });
            sendResponse({success: true, data: message.data});
            if (message.data && !message.data.appYa_token) {
                appService.saveToStorage(APP_CONFIG.storageKeys.database, {appYa_token: false});
            }
            appService.getFromStorage(APP_CONFIG.storageKeys.database).then((result) => {
                const existingDb = result[APP_CONFIG.storageKeys.database] || {};
                const mergedDb = mergeDatabaseState(existingDb, message.data || {});

                return appService.saveToStorage(APP_CONFIG.storageKeys.database, mergedDb);
            }).then(() => {

            }).catch(console.error);
            return;
        }

        if (message.action === "download_Tracks") {
            logger.log('download_Tracks message received', message);
            sendResponse({download_Tracks: message});
            downloadManager.downloadTracks(message).catch((error) => {
                logger.error('downloadTracks top-level failed', error);
            });
            return;
        }

        if (message.action === "resolve_track_info") {
            logger.log('resolve_track_info message received', message);
            sendResponse({
                resolve_track_info: message.trackId,
                slot: message.slot || 'current'
            });
            downloadManager.resolveTrackInfo(message.trackId, message.slot || 'current').catch((error) => {
                logger.error('resolveTrackInfo top-level failed', error);
            });
            return;
        }

        if (message.action === "stop_downloads") {
            logger.log('stop_downloads message received');
            downloadManager.requestStop().then((snapshot) => {
                sendResponse({success: true, state: snapshot});
            }).catch((error) => {
                logger.error('requestStop failed', error);
                sendResponse({success: false, message: error?.message || String(error)});
            });
            return true;
        }

        if (message.action === "download_SFIFTD") {
            const playsPayload = parseStoredJson(message.data?.appYa_plays);
            const resolvedTrackId = pickFirstTrackId(message.data?.appYa_currentTrackId)
                || extractTrackIdFromPlaysPayload(playsPayload);

            if (resolvedTrackId) {
                let downData = {
                    tabId: sender.tab.id,
                    trackIds: [resolvedTrackId],
                    playlistName: 'music'
                };

                logger.log('download_SFIFTD message resolved', downData);

                downloadManager.downloadTracks(downData);
            } else {
                logger.warn('download_SFIFTD skipped because track id was not resolved');
            }
            sendResponse({success: Boolean(resolvedTrackId), trackId: resolvedTrackId});
            return;
        }
    }
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    return worker.onMessage(message, sender, sendResponse);
});
