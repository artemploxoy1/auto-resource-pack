const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const PLUGIN_OWNER_ID = 'plugin:auto-resource-pack';

// Функция для скачивания файла по HTTP/HTTPS с поддержкой редиректов (301/302)
function downloadResourcePack(url, destPath) {
    return new Promise((resolve, reject) => {
        const file = fs.createWriteStream(destPath);
        const client = url.startsWith('https') ? https : http;

        const request = client.get(url, (response) => {
            // Обработка редиректов
            if (response.statusCode === 301 || response.statusCode === 302) {
                downloadResourcePack(response.headers.location, destPath).then(resolve).catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                reject(new Error(`Код ответа: ${response.statusCode} ${response.statusMessage}`));
                return;
            }

            response.pipe(file);

            file.on('finish', () => {
                file.close();
                resolve();
            });
        });

        request.on('error', (err) => {
            fs.unlink(destPath, () => {}); // Удаляем недогруженный файл
            reject(err);
        });

        file.on('error', (err) => {
            fs.unlink(destPath, () => {});
            reject(err);
        });
    });
}

async function onLoad(bot, options) {
    const log = bot.sendLog;
    const settings = options.settings || {};
    const simulatedDelayMs = settings.simulatedDelayMs || 100;

    log('[AutoResourcePack] Инициализация плагина реального скачивания паков и обхода краша при переходе...');

    // Проверка версии бота при запуске
    if (!bot.version || !bot.version.startsWith('1.21')) {
        log(`[AutoResourcePack] ПРЕДУПРЕЖДЕНИЕ: Бот запущен на версии протокола ${bot.version || 'неизвестно'}. Для стабильной игры на FunTime ОБЯЗАТЕЛЬНО укажите версию 1.21.1 в настройках сервера в панели!`, 'warn');
    }

    // --- СЕТЕВОЙ ХОТПАТЧ ДЛЯ ОБХОДА КРАША ПРИ ПАРСИНГЕ DIMENSION CODEC ---
    if (bot.registry && typeof bot.registry.loadDimensionCodec === 'function') {
        const originalLoadDimensionCodec = bot.registry.loadDimensionCodec;
        bot.registry.loadDimensionCodec = function (codec) {
            try {
                return originalLoadDimensionCodec.call(this, codec);
            } catch (err) {
                log(`[AutoResourcePack] [Fix] Ошибка при загрузке Dimension Codec (${err.message}). Применяю безопасный обход для предотвращения краша...`, 'warn');
                
                // Наполняем реестр дефолтными значениями через Object.defineProperty и Proxy для защиты от неизвестных ID (например, ID 3)
                try {
                    const baseDimensionsById = {
                        '-1': { name: 'the_nether', minY: 0, height: 256 },
                        '0': { name: 'overworld', minY: -64, height: 384 },
                        '1': { name: 'the_end', minY: 0, height: 256 }
                    };

                    const proxyDimensionsById = new Proxy(baseDimensionsById, {
                        get: (target, prop) => {
                            if (prop in target) {
                                return target[prop];
                            }
                            return target['0']; // Возвращаем overworld по умолчанию для любых неизвестных ID (например, 3)
                        }
                    });

                    const baseDimensionsByName = {
                        'minecraft:overworld': baseDimensionsById['0'],
                        'minecraft:the_nether': baseDimensionsById['-1'],
                        'minecraft:the_end': baseDimensionsById['1']
                    };

                    const proxyDimensionsByName = new Proxy(baseDimensionsByName, {
                        get: (target, prop) => {
                            if (prop in target) {
                                return target[prop];
                            }
                            return target['minecraft:overworld']; // Дефолт для кастомных названий измерений
                        }
                    });

                    Object.defineProperty(this, 'dimensionsById', {
                        value: proxyDimensionsById,
                        writable: true,
                        configurable: true,
                        enumerable: true
                    });

                    Object.defineProperty(this, 'dimensionsByName', {
                        value: proxyDimensionsByName,
                        writable: true,
                        configurable: true,
                        enumerable: true
                    });

                    log(`[AutoResourcePack] [Fix] Резервный реестр измерений успешно инициализирован (активирована защита Proxy-Fallback).`);
                } catch (fallbackErr) {
                    log(`[AutoResourcePack] [Fix] Ошибка инициализации дефолтных измерений: ${fallbackErr.message}`, 'error');
                }
            }
        };
    }
    // ---------------------------------------------------------------------

    // Создаем папку для сохранения ресурс-паков внутри папки плагина
    const resourcePacksDir = path.join(__dirname, 'resourcepacks');
    try {
        fs.mkdirSync(resourcePacksDir, { recursive: true });
    } catch (err) {
        log(`[AutoResourcePack] Ошибка создания папки resourcepacks: ${err.message}`, 'error');
    }

    // Возобновляем физику только через 2 секунды после спавна в мире (завершен переход между серверами Bungee/Velocity) [3]
    const onSpawn = () => {
        log('[AutoResourcePack] [PhysicsGuard] Бот успешно заспавнился. Запуск таймера активации физики...');
        setTimeout(() => {
            if (bot.autoResourcePack) {
                log('[AutoResourcePack] [PhysicsGuard] Физика бота возобновлена.');
                bot.physicsEnabled = true;
            }
        }, 2000);
    };
    bot.on('spawn', onSpawn);

    bot.autoResourcePack = {
        listeners: new Map(),
        client: null,
        onSpawn: onSpawn
    };

    // Безопасный метод отправки ответа на ресурс-пак через стандартный сериализатор
    const sendResourcePackResponse = (client, result, uuid) => {
        try {
            if (client && client.write) {
                client.write('resource_pack_receive', { uuid, result });
                log(`[AutoResourcePack] Отправлен статус ${result} для UUID: ${uuid}`);
            } else {
                log(`[AutoResourcePack] Ошибка: Клиент недоступен для отправки статуса ${result}`, 'error');
            }
        } catch (err) {
            log(`[AutoResourcePack] Ошибка при отправке статуса ${result}: ${err.message}`, 'error');
        }
    };

    const attachListeners = (client) => {
        if (!client) return;
        if (bot.autoResourcePack.client === client) return;
        
        removeListeners();
        bot.autoResourcePack.client = client;

        // --- СЕТЕВОЙ ХОТПАТЧ И ФИЛЬТР ПАКЕТОВ ДЛЯ ОБХОДА КРАША НА FUNTIME ---
        const originalWrite = client.write;
        const allowedConfigPackets = [
            'client_information',
            'settings',
            'custom_payload',
            'configuration_acknowledged',
            'resource_pack_receive',
            'select_known_packs',
            'pong',
            'cookie_response',
            'keep_alive',
            'finish_configuration' // <-- Теперь пакет успешно отправляется серверу
        ];

        client.write = function (name, params) {
            if (client.state === 'configuration') {
                if (!allowedConfigPackets.includes(name)) {
                    log(`[AutoResourcePack] [PhysicsGuard] Блокирую отправку пакета "${name}" в фазе конфигурации для предотвращения кика.`);
                    return;
                }
                
                if (name === 'settings') {
                    log('[AutoResourcePack] [Fix] Перенаправляю устаревший "settings" в "client_information"...');
                    return originalWrite.call(client, 'client_information', params);
                }
            }
            return originalWrite.apply(client, arguments);
        };
        // ---------------------------------------------------------------------

        // При входе в фазу конфигурации приостанавливаем физику
        client.on('start_configuration', () => {
            log('[AutoResourcePack] [PhysicsGuard] Вход в фазу конфигурации (перенаправление). Отключаю физику бота...');
            bot.physicsEnabled = false;
            bot.clearControlStates();
        });

        // При выходе из конфигурации просто пишем лог. Физика включится только в ивенте 'spawn'!
        client.on('finish_configuration', () => {
            log('[AutoResourcePack] [PhysicsGuard] Выход из фазы конфигурации. Ожидаю спавна в мире...');
        });

        const onAddResourcePack = async (data) => {
            const uuid = data.uuid;
            const url = data.url;
            log(`[AutoResourcePack] [1.20.3+] Получен запрос ресурс-пака. UUID: ${uuid}. URL: ${url}`);

            try {
                sendResourcePackResponse(client, 3, uuid); // ACCEPTED (3)

                const fileName = `${uuid}.zip`;
                const destPath = path.join(resourcePacksDir, fileName);

                const startTime = Date.now();
                await downloadResourcePack(url, destPath);
                const downloadTime = ((Date.now() - startTime) / 1000).toFixed(2);
                
                log(`[AutoResourcePack] Ресурс-пак успешно скачан за ${downloadTime} сек.`);

                sendResourcePackResponse(client, 2, uuid); // DOWNLOADED (2)

                setTimeout(() => {
                    try {
                        if (client.state === 'closed' || bot.autoResourcePack.client !== client) return;
                        sendResourcePackResponse(client, 0, uuid); // SUCCESSFULLY_LOADED (0)
                    } catch (err) {
                        log(`[AutoResourcePack] Ошибка при отправке SUCCESSFULLY_LOADED: ${err.message}`, 'error');
                    }
                }, simulatedDelayMs);

            } catch (err) {
                log(`[AutoResourcePack] Ошибка обработки ресурс-пака: ${err.message}`, 'error');
                try {
                    sendResourcePackResponse(client, 2, uuid); // FAILED_DOWNLOAD (2)
                } catch (e) {}
            }
        };

        // Обработка обязательного для 1.21+ пакета выбора известных паков
        const onSelectKnownPacks = (data) => {
            log(`[AutoResourcePack] Получен запрос select_known_packs (${(data.packs || []).length} паков). Отвечаю...`);
            try {
                client.write('select_known_packs', { packs: data.packs || [] });
            } catch (err) {
                log(`[AutoResourcePack] Ошибка при отправке select_known_packs: ${err.message}`, 'error');
            }
        };

        client.on('add_resource_pack', onAddResourcePack);
        client.on('select_known_packs', onSelectKnownPacks);

        bot.autoResourcePack.listeners.set('add_resource_pack', onAddResourcePack);
        bot.autoResourcePack.listeners.set('select_known_packs', onSelectKnownPacks);

        const onResourcePackSend = async (data) => {
            const hash = data.hash || 'legacy';
            const url = data.url;
            log(`[AutoResourcePack] [Legacy] Получен запрос ресурс-пака. Hash: ${hash}. URL: ${url}`);

            try {
                client.write('resource_pack_receive', { hash, result: 3 }); // ACCEPTED (3)
                log(`[AutoResourcePack] Отправлен статус ACCEPTED (3). Начинаю скачивание...`);

                const fileName = `${hash}.zip`;
                const destPath = path.join(resourcePacksDir, fileName);
                
                await downloadResourcePack(url, destPath);
                log(`[AutoResourcePack] Ресурс-пак успешно скачан: ${fileName}`);

                setTimeout(() => {
                    try {
                        if (client.state === 'closed' || bot.autoResourcePack.client !== client) return;
                        client.write('resource_pack_receive', { hash, result: 0 }); // SUCCESSFULLY_LOADED (0)
                        log(`[AutoResourcePack] Отправлен статус SUCCESSFULLY_LOADED (0)`);
                    } catch (err) {
                        log(`[AutoResourcePack] Ошибка при отправке SUCCESSFULLY_LOADED: ${err.message}`, 'error');
                    }
                }, simulatedDelayMs);

            } catch (err) {
                log(`[AutoResourcePack] Ошибка при скачивании легаси-пака: ${err.message}`, 'error');
            }
        };

        client.on('resource_pack_send', onResourcePackSend);
        bot.autoResourcePack.listeners.set('resource_pack_send', onResourcePackSend);
    };

    const removeListeners = () => {
        const client = bot.autoResourcePack.client;
        if (!client) return;

        for (const [event, listener] of bot.autoResourcePack.listeners.entries()) {
            client.removeListener(event, listener);
        }
        bot.autoResourcePack.listeners.clear();
        bot.autoResourcePack.client = null;
    };

    if (bot._client) {
        attachListeners(bot._client);
    }

    const onLogin = () => {
        log('[AutoResourcePack] Перепривязываю обработчики к новому клиенту...');
        attachListeners(bot._client);
    };
    bot.on('login', onLogin);
    bot.autoResourcePack.onLogin = onLogin;

    log(`[AutoResourcePack] Плагин успешно запущен.`);
}

async function onUnload({ botId, prisma }) {
    if (bot.autoResourcePack && bot.autoResourcePack.onSpawn) {
        bot.removeListener('spawn', bot.autoResourcePack.onSpawn);
    }
    try {
        await prisma.command.deleteMany({ where: { botId, owner: PLUGIN_OWNER_ID } });
        await prisma.permission.deleteMany({ where: { botId, owner: PLUGIN_OWNER_ID } });
    } catch (err) {
        console.error(`[AutoResourcePack] Ошибка очистки БД: ${err.message}`);
    }
}

module.exports = {
    onLoad,
    onUnload
};
