function readManifestMeta() {
    try {
        const manifest = globalThis.chrome?.runtime?.getManifest?.() ?? {};
        return Object.freeze({
            name: manifest.name ?? 'Audio Library Helper',
            title: manifest.action?.default_title ?? manifest.name ?? 'Audio Library Helper',
            description: manifest.description ?? '',
            version: manifest.version ?? ''
        });
    } catch (error) {
        return Object.freeze({
            name: 'Audio Library Helper',
            title: 'Audio Library Helper',
            description: '',
            version: ''
        });
    }
}

const APP_MANIFEST = readManifestMeta();

/**
 * Централизованная конфигурация расширения.
 * Содержит неизменяемые значения для UI, API, storage и настроек по умолчанию.
 */
const APP_CONFIG = Object.freeze({
    appName: APP_MANIFEST.name,
    appTitle: APP_MANIFEST.title,
    appDescription: APP_MANIFEST.description,
    appVersion: APP_MANIFEST.version,
    debug: Object.freeze({
        enabled: true,
        prefix: 'ALH'
    }),
    storageKeys: Object.freeze({
        settings: 'app_setting',
        database: 'appYa_db',
        tabId: 'appYa_tabID'
    }),
    settingsLocalStoragePrefix: 'appYa_setting_',
    defaults: Object.freeze({
        downloadFolder: 'music/%genre%',
        coverQuality: 600,
        audioQuality: 'lossless',
        downlodadCount: 4,
        savehistory: '0',
        numberingTracks: false,
        theme: 'auto'
    }),
    themeValues: Object.freeze(['auto', 'light', 'dark']),
    templateVariables: Object.freeze([
        {token: '%dir%', label: 'Источник загрузки'},
        {token: '%genre%', label: 'Жанр'},
        {token: '%year%', label: 'Год'},
        {token: '%artist%', label: 'Артист'},
        {token: '%album%', label: 'Альбом'}
    ]),
    uiText: Object.freeze({
        optionsTitle: 'Настройки',
        optionsSubtitle: 'Базовая конфигурация расширения: оформление, качество, папки и поведение загрузки.',
        optionsSaveSuccess: 'Настройки сохранены.',
        parserButtonDefault: 'Скачать',
        parserButtonPreparing: 'Подготовка к скачиванию...',
        parserButtonDownloading: 'Скачивание...',
        popupEmptyTrack: 'Включите трек на странице сервиса и вернитесь сюда.',
        popupResolvingTrack: 'Получаем данные текущего трека...',
        popupEmptyState: 'Обновите страницу музыкального сервиса и откройте окно ещё раз.',
        popupAuthTitle: 'Требуется авторизация',
        popupAuthDescription: 'Для доступа к данным сервиса нужно один раз подтвердить авторизацию.',
        popupCurrentTrack: 'Текущий трек',
        popupShortcuts: 'SHIFT+D или двойной клик',
        popupSettings: 'Настройки',
        popupAuthorize: 'Авторизация',
        popupTokenLabel: 'Токен до',
        popupTokenRefresh: 'Обновить',
        popupDownloadSelected: 'Скачать выбранное',
        popupDownloadArtist: 'Скачать все треки артиста',
        popupDownloadAlbum: 'Скачать все треки альбома',
        popupDownloadChart: 'Скачать чарт',
        popupPlaylistTitle: 'Плейлист',
        popupArtistTitle: 'Артист',
        popupAlbumTitle: 'Альбом',
        popupAlbumsSection: 'Альбомы',
        popupTrackRangeLabel: 'Выбрано треков:',
        popupTrackRangeStart: 'От:',
        popupTrackRangeEnd: 'До:',
        popupArtistFallbackTitle: 'Артист',
        popupPlaylistMetaAuthor: 'Автор',
        popupPlaylistMetaCount: 'Кол-во',
        popupRangeAll: 'Все',
        popupRangeCount: 'шт'
    }),
    yandex: Object.freeze({
        locationOrigin: 'https://music.yandex.ru/?yamusic=ok',
        redirectUri: 'https://music.yandex.ru/oauth',
        apiUrl: 'https://api.music.yandex.ru/',
        oauthUrl: 'https://oauth.yandex.ru/',
        clientId: '97fe03033fa34407ac9bcf91d5afed5b',
        signingSecret: 'kzqU4XhfCaY6B6JTHODeq5',
        desktopClientHeader: 'YandexMusicDesktopAppWindows/1'
    }),
    badgeColors: Object.freeze([
        '#FF5733',
        '#33FF57',
        '#3357FF',
        '#FF33A1',
        '#FFBD33',
        '#33FFF4',
        '#B333FF',
        '#33FFA1',
        '#FFA133',
        '#A133FF',
        '#33A1FF',
        '#FFA1A1'
    ])
});

/**
 * Возвращает новый объект с настройками по умолчанию.
 * @returns {object} Копия дефолтных настроек.
 */
function getDefaultSettings() {
    return {...APP_CONFIG.defaults};
}

/**
 * Нормализует пользовательские настройки и приводит значения к ожидаемым типам.
 * @param {object} [input={}] Исходные настройки из storage или формы.
 * @returns {object} Полный объект настроек с дефолтами и корректными типами.
 */
function normalizeSettings(input = {}) {
    return {
        ...getDefaultSettings(),
        ...input,
        coverQuality: parseInt(input.coverQuality ?? APP_CONFIG.defaults.coverQuality, 10),
        downlodadCount: parseInt(input.downlodadCount ?? APP_CONFIG.defaults.downlodadCount, 10),
        savehistory: String(input.savehistory ?? APP_CONFIG.defaults.savehistory),
        numberingTracks: Boolean(input.numberingTracks),
        theme: APP_CONFIG.themeValues.includes(input.theme) ? input.theme : APP_CONFIG.defaults.theme
    };
}

/**
 * Создаёт scoped-логгер с единым префиксом для упрощения отладки.
 * @param {string} scope Имя модуля или подсистемы.
 * @returns {{log: Function, warn: Function, error: Function}} Объект с методами логирования.
 */
function createDebugLogger(scope) {
    const formatPrefix = `[${APP_CONFIG.debug.prefix}:${scope}]`;

    return {
        log(...args) {
            if (APP_CONFIG.debug.enabled) {
                console.log(formatPrefix, ...args);
            }
        },
        warn(...args) {
            if (APP_CONFIG.debug.enabled) {
                console.warn(formatPrefix, ...args);
            }
        },
        error(...args) {
            if (APP_CONFIG.debug.enabled) {
                console.error(formatPrefix, ...args);
            }
        }
    };
}

globalThis.APP_CONFIG = APP_CONFIG;
globalThis.getDefaultSettings = getDefaultSettings;
globalThis.normalizeSettings = normalizeSettings;
globalThis.createDebugLogger = createDebugLogger;
