/**
 * Content script синхронизирует настройки, проксирует сообщения между страницей
 * и расширением, а также поддерживает горячие клавиши скачивания.
 */
const logger = createDebugLogger('content');
const windowMessageSource = 'YMF_PAGE';

logger.log('content.js loaded');

/**
 * Просит service worker внедрить page-script в контекст страницы Яндекс Музыки.
 */
chrome.runtime.sendMessage({action: "inject_parser"}, (data) => {
    if (chrome.runtime.lastError) {
        logger.error('inject_parser failed', chrome.runtime.lastError.message);
    } else {
        logger.log('inject_parser completed', data);
    }
});


const settingsStorageKey = APP_CONFIG.storageKeys.settings;

/**
 * Переносит настройки из `chrome.storage.local` в `localStorage` страницы,
 * чтобы page-script мог читать их из основного мира.
 */
chrome.storage.local.get(settingsStorageKey, (result) => {
    const settings = normalizeSettings(result[settingsStorageKey]);
    chrome.storage.local.set({[settingsStorageKey]: settings});
    logger.log('settings synced to localStorage', settings);

    for (const [key, value] of Object.entries(settings)) {
        const localStorageKey = `${APP_CONFIG.settingsLocalStoragePrefix}${key}`;
        logger.log('localStorage set', {localStorageKey, value});
        localStorage.setItem(localStorageKey, value);
    }
});


let previousState = JSON.stringify(localStorage);

/**
 * Отслеживает изменения в localStorage страницы и синхронизирует их в storage расширения.
 * @returns {void}
 */
const checkLocalStorageUpdates = () => {
    try {
        // Получаем текущее состояние localStorage
        let currentState = JSON.stringify(localStorage);

        // Сравниваем текущее и предыдущее состояние
        if (currentState !== previousState) {

            // Обновляем предыдущее состояние
            previousState = currentState;


            // Отправляем обновленные данные в background.js
            chrome.runtime.sendMessage({
                action: "send_localStorage",
                data: {...window.localStorage} // Передаем копию localStorage
            }, (response) => {
                if (chrome.runtime.lastError) {
                    logger.error('send_localStorage failed', chrome.runtime.lastError.message);
                } else {
                    logger.log('send_localStorage completed');
                }
            });
        }
    } catch (error) {
        logger.error('Ошибка при проверке localStorage', error);
    }
};

setInterval(checkLocalStorageUpdates, 1000);


/**
 * Запускает скачивание текущего трека по горячей клавише `Shift + D`.
 */
document.addEventListener('keydown', function (event) {
    // event.code 'KeyD' срабатывает для физической клавиши D/В независимо от раскладки
    if (event.shiftKey && event.code === 'KeyD') {
        event.preventDefault();

        try {
            chrome.runtime.sendMessage({
                action: "download_SFIFTD",
                data: {...window.localStorage}
            }, (response) => {
                if (chrome.runtime.lastError) {
                    logger.warn('download_SFIFTD failed after keydown', chrome.runtime.lastError.message);
                }
            });
        } catch (e) {
            logger.error('extension context is invalid on keydown', e);
        }
    }
}, true);

/**
 * Принимает сообщения от page-script и перенаправляет их в service worker.
 */
window.addEventListener('message', (event) => {
    if (event.source !== window) {
        return;
    }

    const data = event.data;
    if (!data || data.source !== windowMessageSource) {
        return;
    }

    if (data.type === 'DOWNLOAD_TRACK' && data.payload?.trackId) {
        logger.log('window message DOWNLOAD_TRACK received', data.payload);
        chrome.runtime.sendMessage({
            action: "download_Tracks",
            tabId: data.payload.tabId,
            trackIds: [data.payload.trackId],
            playlistName: data.payload.playlistName || 'music'
        }, (response) => {
            if (chrome.runtime.lastError) {
                logger.error('DOWNLOAD_TRACK runtime message failed', chrome.runtime.lastError.message);
            } else {
                logger.log('DOWNLOAD_TRACK runtime message accepted', response);
            }
        });
    }

    if (data.type === 'RESOLVE_TRACK_INFO' && data.payload?.trackId) {
        logger.log('window message RESOLVE_TRACK_INFO received', data.payload);
        chrome.runtime.sendMessage({
            action: "resolve_track_info",
            trackId: data.payload.trackId
        }, (response) => {
            if (chrome.runtime.lastError) {
                logger.error('RESOLVE_TRACK_INFO runtime message failed', chrome.runtime.lastError.message);
            } else {
                logger.log('RESOLVE_TRACK_INFO runtime message accepted', response);
            }
        });
    }
}, true);


/**
 * Запускает скачивание текущего трека по двойному клику вне интерактивных элементов.
 */
document.addEventListener('dblclick', function (event) {
    // Не срабатывать, если кликнули по полю ввода или кнопке
    const tag = event.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'BUTTON') return;

    try {
        // Проверяем, что расширение все еще "живо"
        if (chrome.runtime && chrome.runtime.id) {
            chrome.runtime.sendMessage({
                action: "download_SFIFTD",
                data: {...window.localStorage}
            }, (response) => {
                // Обработка ответа, если нужно
                if (chrome.runtime.lastError) { /* игнорируем */
                }
            });
        }
    } catch (e) {
        logger.warn('extension context lost on double click', e);
    }
}, true);
