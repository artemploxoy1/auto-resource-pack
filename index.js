const PLUGIN_OWNER_ID = 'plugin:auto-resource-pack';

async function onLoad(bot, options) {
    const log = bot.sendLog;
    const settings = options.settings || {};
    const simulatedDelayMs = settings.simulatedDelayMs || 100;

    log('[AutoResourcePack] Инициализация плагина...');

    // Объект для хранения наших обработчиков, чтобы безопасно управлять ими
    bot.autoResourcePack = {
        listeners: new Map(),
        client: null
    };

    const attachListeners = (client) => {
        if (!client) return;
        
        // Если мы уже привязались к этому клиенту, повторно не привязываемся
        if (bot.autoResourcePack.client === client) return;
        
        // Сначала очищаем старые обработчики, если они были активны
        removeListeners();
        
        bot.autoResourcePack.client = client;

        // Обработчик для современных версий (1.20.3+)
        const onAddResourcePack = (data) => {
            const uuid = data.uuid;
            log(`[AutoResourcePack] [1.20.3+] Получен запрос ресурс-пака. UUID: ${uuid}`);
            try {
                // Статус 3 = ACCEPTED (Ресурс-пак принят клиентом)
                client.write('resource_pack_receive', { uuid, result: 3 });
                log(`[AutoResourcePack] Отправлен статус ACCEPTED (3) для UUID: ${uuid}`);

                // Имитируем скачивание
                setTimeout(() => {
                    try {
                        if (client.state === 'closed' || bot.autoResourcePack.client !== client) return;
                        // Статус 0 = SUCCESSFULLY_LOADED (Успешно загружен)
                        client.write('resource_pack_receive', { uuid, result: 0 });
                        log(`[AutoResourcePack] Отправлен статус SUCCESSFULLY_LOADED (0) для UUID: ${uuid}`);
                    } catch (err) {
                        log(`[AutoResourcePack] Ошибка при отправке SUCCESSFULLY_LOADED: ${err.message}`, 'error');
                    }
                }, simulatedDelayMs);
            } catch (err) {
                log(`[AutoResourcePack] Ошибка при отправке ACCEPTED: ${err.message}`, 'error');
            }
        };

        // Обработчик для старых версий (Legacy)
        const onResourcePackSend = (data) => {
            const hash = data.hash;
            log(`[AutoResourcePack] [Legacy] Получен устаревший запрос ресурс-пака. Hash: ${hash}`);
            try {
                // Статус 3 = ACCEPTED (Ресурс-пак принят клиентом)
                client.write('resource_pack_receive', { hash, result: 3 });
                log(`[AutoResourcePack] Отправлен статус ACCEPTED (3) для Hash: ${hash}`);

                // Имитируем скачивание
                setTimeout(() => {
                    try {
                        if (client.state === 'closed' || bot.autoResourcePack.client !== client) return;
                        // Статус 0 = SUCCESSFULLY_LOADED (Успешно загружен)
                        client.write('resource_pack_receive', { hash, result: 0 });
                        log(`[AutoResourcePack] Отправлен статус SUCCESSFULLY_LOADED (0) для Hash: ${hash}`);
                    } catch (err) {
                        log(`[AutoResourcePack] Ошибка при отправке SUCCESSFULLY_LOADED: ${err.message}`, 'error');
                    }
                }, simulatedDelayMs);
            } catch (err) {
                log(`[AutoResourcePack] Ошибка при отправке ACCEPTED: ${err.message}`, 'error');
            }
        };

        client.on('add_resource_pack', onAddResourcePack);
        client.on('resource_pack_send', onResourcePackSend);

        bot.autoResourcePack.listeners.set('add_resource_pack', onAddResourcePack);
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

    // Привязка при создании клиента
    if (bot._client) {
        attachListeners(bot._client);
    }

    // Перепривязка при логине/реконнекте
    const onLogin = () => {
        log('[AutoResourcePack] Авторизация успешна. Привязываю обработчики пакетов к новому клиенту...');
        attachListeners(bot._client);
    };
    bot.on('login', onLogin);
    bot.autoResourcePack.onLogin = onLogin;

    log(`[AutoResourcePack] Плагин успешно запущен.`);
}

async function onUnload({ botId, prisma }) {
    try {
        await prisma.command.deleteMany({
            where: { botId, owner: PLUGIN_OWNER_ID }
        });
        await prisma.permission.deleteMany({
            where: { botId, owner: PLUGIN_OWNER_ID }
        });
    } catch (err) {
        console.error(`[AutoResourcePack] Ошибка очистки БД при удалении плагина: ${err.message}`);
    }
}

module.exports = {
    onLoad,
    onUnload
};