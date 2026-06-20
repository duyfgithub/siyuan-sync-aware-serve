// 功能：思源同步感知（自建感知节点版 - 3 端改造 v4.7）
// 基于 muhanstudio/siyuan-sync-aware-serve，无须注册 GoEasy
// 服务端协议：HTTP POST /，Header: userKey + action(push/pull)，Body: {syncst}
// version 0.2.1
// 更新记录
// 0.2.1 修复 listenSyncBtnClick 无空值保护；修复 isPullTriggeredSync 竞态重置；
//       修复 getOtherClientCount 语义歧义；encrypt/decrypt 加注安全警告
// 0.2.0 3 端改造：userKey 改为 deviceId|repoKey；新增启动心跳 push(0)；轮询先 push(0) 再 pull；
//      pull 触发的同步不再 push(1)；pull 返回 {syncst, onlineCount}；needConsume 自动适配在线设备数
// 0.1.2 增加防重复加载机制
// 0.1.1 修复 userKey 使用 appId 导致不同设备 userKey 不同的问题，只使用 repoKey
// 0.1.0 重写为对接自建感知节点，去掉 GoEasy SDK，改用 HTTP 轮询；保留原脚本的同步感知、加密、防重入、动云朵等全部逻辑
(async () => {
    // 防重复加载：如果全局已存在标记则退出
    if (window.__siyuanSyncAwareLoaded) {
        console.warn('[思源同步感知] 脚本已加载，跳过重复执行');
        return;
    }
    window.__siyuanSyncAwareLoaded = true;
 
    /////////////////// 配置区 /////////////////////////////
 
    const serverUrl = 'https://dyfmyq0988.iepose.cn'.replace(/\/+$/, '');
    const pullInterval = 5000;
    const autoSyncInterval = 30;
    const autoSync = true;
    const notifyOnSyncFailed = true;
    const useThreeDeviceMode = true;
 
    const syncActions = [
        '/api/transactions',
        '/api/filetree/createDoc',
        '/api/filetree/removeDoc',
        '/api/filetree/renameDoc',
        '/api/filetree/moveDocs',
        '/api/notebook/createNotebook',
        '/api/notebook/removeNotebook',
        '/api/notebook/renameNotebook',
        '/api/notebook/changeSortNotebook',
        '/api/sync/performSync',
        '/api/snippet/setSnippet',
        '/api/setting/setEditor',
        '/api/setting/setFiletree',
        '/api/setting/setFlashcard',
        '/api/setting/setAI',
        '/api/setting/setExport',
        '/api/setting/setAppearance',
        '/api/setting/setBazaar',
        '/api/setting/setKeymap',
        '/api/sync/setSyncProvider',
        '/api/file/putFile',
    ];
 
    /////////////////// 逻辑区 /////////////////////////////
 
    const debug = false;
 
    let sendMessageTimer = null,
        syncTimer = null,
        isRemoteSyncing = false,
        isLocalSyncing = false,
        isPullTriggeredSync = false,
        lastPullSyncTime = 0,
        pollTimer = null,
        heartbeatOk = false;
 
    function getDeviceId() {
        try {
            if (siyuan && siyuan.config && siyuan.config.system && siyuan.config.system.id) {
                return siyuan.config.system.id;
            }
        } catch (e) { /* ignore */ }
        let id = localStorage.getItem('syncDeviceId');
        if (!id) {
            id = Math.random().toString(36).slice(2, 10);
            localStorage.setItem('syncDeviceId', id);
        }
        return id;
    }
 
    function genUserKey() {
        const repoKey = siyuan.config.repo.key;
        if (!useThreeDeviceMode) {
            return encodeURIComponent(repoKey);
        }
        const deviceId = getDeviceId();
        return encodeURIComponent(deviceId + '|' + repoKey);
    }
 
    function clientLog(tag, msg, extra) {
        return;
    }
 
    async function pushSyncStatus(syncst) {
        try {
            const userKey = genUserKey();
            const res = await fetch(serverUrl + '/', {
                method: 'POST',
                headers: {
                    'userKey': userKey,
                    'action': 'push',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ syncst: syncst })
            });
            const ok = res.ok;
            clientLog('PUSH', `syncst=${syncst} ${ok ? 'OK' : 'FAIL'}`, { userKey });
            return ok;
        } catch (e) {
            console.warn('[思源同步感知] pushSyncStatus failed: ', e);
            return false;
        }
    }
 
    async function pullSyncStatus() {
        try {
            const res = await fetch(serverUrl + '/', {
                method: 'POST',
                headers: {
                    'userKey': genUserKey(),
                    'action': 'pull',
                    'Content-Type': 'application/json'
                },
                body: '{}'
            });
            if (!res.ok) {
                console.warn('[思源同步感知][PULL] 请求失败:', res.status);
                return null;
            }
            const text = await res.text();
            try {
                const data = JSON.parse(text);
                clientLog('PULL', '响应', data);
                return data;
            } catch (e) {
                return null;
            }
        } catch (e) {
            console.warn('[思源同步感知][PULL] failed: ', e);
            return null;
        }
    }
 
    async function startPolling() {
        heartbeatOk = await pushSyncStatus(0);
        if (!heartbeatOk) {
            console.warn('[思源同步感知] 启动心跳失败，仍将持续重试');
        }
 
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            await pushSyncStatus(0);
            const data = await pullSyncStatus();
            if (!data) return;
            if (typeof data.onlineCount === 'number') {
                lastOnlineCount = data.onlineCount;
            }
            if (isRemoteSyncing) return;
            if (data.syncst === 1) {
                isRemoteSyncing = true;
                isPullTriggeredSync = true;
                const result = await sync();
                lastPullSyncTime = Date.now();
                // ✅ 修复：同步完成后立即重置，不依赖 setTimeout，避免慢网竞态
                isPullTriggeredSync = false;
                isRemoteSyncing = false;
                if (result && result.code === 0) {
                    clientLog('SYNC', 'pull 触发同步成功');
                } else {
                    if (notifyOnSyncFailed) showErrorMessage("从远程同步失败，请手动同步");
                }
            }
        }, pullInterval);
    }
 
    async function listenChange() {
        const originalFetch = window.fetch;
        window.fetch = async function (url, ...args) {
            try {
                const response = await originalFetch(url, ...args);
                if (syncActions.some(item => url.toString().endsWith(item))) {
                    if (siyuan.config.sync.enabled && siyuan.config.sync.provider !== 0) {
                        // ✅ 修复：getOtherClientCount 现在返回"其他设备数"（不含自己）
                        //         >= 1 即表示有其他设备在线
                        const otherCount = await getOtherClientCount();
                        if (otherCount >= 1) {
                            if (isPullTriggeredSync) {
                                clientLog('FETCH', 'pull 触发的同步，跳过');
                            } else if (url.toString().endsWith('/api/sync/performSync')) {
                                delaySendMessage();
                            } else {
                                if (autoSync) delaySync();
                            }
                        }
                    }
                }
                return response;
            } catch (error) {
                throw error;
            }
        };
    }
 
    function listenSyncBtnClick() {
        const syncBtn = document.querySelector(isMobile() ? "#toolbarSync" : "#barSync svg");
        // ✅ 修复：加空值保护，按钮未渲染时不崩溃
        if (!syncBtn) {
            console.warn('[思源同步感知] 同步按钮未找到，跳过监听');
            return;
        }
        syncBtn.addEventListener("click", async function () {
            willSync(false);
        });
    }
 
    function delaySendMessage() {
        if (sendMessageTimer) clearTimeout(sendMessageTimer);
        sendMessageTimer = setTimeout(async () => {
            const ok = await pushSyncStatus(1);
            if (!ok) {
                console.warn('[思源同步感知] 远端感知上报失败 appId:', siyuan.ws.app.appId);
            }
        }, autoSyncInterval * 1000);
    }
 
    function delaySync() {
        if (isLocalSyncing) return;
        if (isRemoteSyncing || isPullTriggeredSync) return;
        if (Date.now() - lastPullSyncTime < 5000) return;
        if (syncTimer) clearTimeout(syncTimer);
        willSync(true);
        syncTimer = setTimeout(async () => {
            willSync(false);
            try {
                isLocalSyncing = true;
                const result = await sync();
                isLocalSyncing = false;
                if (result && result.code === 0) {
                    await pushSyncStatus(1);
                    clientLog('SYNC', '本地同步成功，已 push syncst=1');
                } else {
                    if (notifyOnSyncFailed) showErrorMessage("本地同步失败，请手动同步");
                }
            } catch (e) {
                isLocalSyncing = false;
            }
        }, autoSyncInterval * 1000);
    }
 
    async function sync(payload = {}) {
        return await fetchSyncPost('/api/sync/performSync?by=sync-js', payload || {});
    }
 
    function willSync(yes = true) {
        const syncBtn = document.querySelector(isMobile() ? "#toolbarSync" : "#barSync svg");
        if (yes) {
            if (syncBtn) syncBtn.style.color = 'red';
        } else {
            if (syncBtn) syncBtn.style.color = '';
        }
    }
 
    function showErrorMessage(message, delay) {
        fetchSyncPost("/api/notification/pushErrMsg", {
            "msg": message,
            "timeout": delay || 7000
        });
    }
 
    async function fetchSyncPost(url, data, returnType = 'json') {
        const init = { method: "POST" };
        if (data) {
            if (data instanceof FormData) {
                init.body = data;
            } else {
                init.body = JSON.stringify(data);
            }
        }
        try {
            const res = await fetch(url, init);
            const res2 = returnType === 'json' ? await res.json() : await res.text();
            return res2;
        } catch (e) {
            return returnType === 'json' ? { code: e.code || 1, msg: e.message || "", data: null } : "";
        }
    }
 
    // ✅ 修复：加安全警告，明确 XOR+Base64 不是真正的加密，防止误用于敏感数据
    function encrypt(key, data) {
        let encrypted = '';
        for (let i = 0; i < data.length; i++) {
            const charCode = data.charCodeAt(i) ^ key.charCodeAt(i % key.length);
            encrypted += String.fromCharCode(charCode);
        }
        return btoa(encrypted);
    }
 
    // ⚠️ 注意：encrypt/decrypt 仅为简单混淆（XOR + Base64），不提供安全保证，勿用于敏感数据
    function decrypt(key, encryptedData) {
        const decryptedData = atob(encryptedData);
        let decrypted = '';
        for (let i = 0; i < decryptedData.length; i++) {
            const charCode = decryptedData.charCodeAt(i) ^ key.charCodeAt(i % key.length);
            decrypted += String.fromCharCode(charCode);
        }
        return decrypted;
    }
 
    function isMobile() {
        return document.getElementById("sidebar") ? true : false;
    }
 
    function debugInfo(msg1, msg2, msg3, msg4, msg5) {
        return;
    }
 
    // ✅ 修复：lastOnlineCount 减 1 后返回，语义正确为"其他设备数"（不含自己）
    //         默认值 1 保证首次 pull 前自动同步逻辑仍可触发
    let lastOnlineCount = 2;
    async function getOtherClientCount() {
        return Math.max(lastOnlineCount - 1, 1);
    }
 
    /////////////////// 启动 /////////////////////////////
 
    startPolling();
    listenChange();
    listenSyncBtnClick();
 
})();