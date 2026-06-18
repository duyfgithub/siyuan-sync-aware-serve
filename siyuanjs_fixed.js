// 功能：思源同步感知（自建感知节点版 - 3 端改造 v4.7）
// 基于 muhanstudio/siyuan-sync-aware-serve，无须注册 GoEasy
// 服务端协议：HTTP POST /，Header: userKey + action(push/pull)，Body: {syncst}
// version 0.2.0
// 更新记录
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
    // console.log('[思源同步感知] 脚本加载中... (v0.2.0 3端改造)');

    /////////////////// 配置区 /////////////////////////////

    // 自建感知节点地址，自动去除结尾多余的 /
    const serverUrl = 'https://dyfmyq0988.iepose.cn'.replace(/\/+$/, '');

    // 轮询间隔，单位毫秒，默认5秒拉一次。值越小感知越实时，但服务器压力越大
    const pullInterval = 5000;

    // 自动同步间隔时间，单位秒，默认30秒，0则立即同步（注意设置过小容易导致冲突）
    // 该参数意思是文件无变化后autoSyncInterval秒后同步，文件一直变化不会同步
    const autoSyncInterval = 30;

    // 是否自动同步，设为false后，修改内容时不会自动同步，但手动同步时会被其他客户端感知到
    const autoSync = true;

    // 当同步失败时是否通知用户？true通知，false不通知
    const notifyOnSyncFailed = true;

    // 是否启用 3 端模式（userKey = deviceId|repoKey）。true=新模式；false=旧模式（纯 repoKey）
    const useThreeDeviceMode = true;

    // 需要同步的操作，可根据自己的需要增删，注释或删除该行即可关闭
    const syncActions = [
        // 文档操作
        '/api/transactions',
        '/api/filetree/createDoc',
        '/api/filetree/removeDoc',
        '/api/filetree/renameDoc',
        '/api/filetree/moveDocs',
        // 笔记操作
        '/api/notebook/createNotebook',
        '/api/notebook/removeNotebook',
        '/api/notebook/renameNotebook',
        '/api/notebook/changeSortNotebook',
        // 同步操作，已做了特殊处理，不会导致死循环
        '/api/sync/performSync',
        // 配置
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
        // 文件操作
        '/api/file/putFile',
        // 资源操作
        //'/api/asset/removeUnusedAsset',
        // 文件回滚操作（非快照回滚）
        //'/api/history/rollbackDocHistory'
    ];

    /////////////////// 逻辑区 /////////////////////////////

    // 定义调试模式（日志已关闭，如需调试改为 true）
    const debug = false;

    //// 定义全局变量 ////
    // 拆分为两个独立 timer，避免手动同步与编辑同步互相干扰
    let sendMessageTimer = null,
        syncTimer = null,
        isRemoteSyncing = false,
        isLocalSyncing = false,
        isPullTriggeredSync = false,
        lastPullSyncTime = 0,  // 记录 pull 触发同步的完成时间
        pollTimer = null,
        heartbeatOk = false;   // 启动心跳是否成功

    //// 生成稳定 deviceId（同一设备多次启动保持一致）////
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

    /**
     * 生成 userKey
     * - 新模式（3 端）：{deviceId}|{repoKey}
     * - 旧模式：纯 {repoKey}（兼容）
     */
    function genUserKey() {
        const repoKey = siyuan.config.repo.key;
        if (!useThreeDeviceMode) {
            return encodeURIComponent(repoKey);
        }
        const deviceId = getDeviceId();
        return encodeURIComponent(deviceId + '|' + repoKey);
    }

    //// 客户端日志（控制台）////
    // 日志已禁用：保留函数为兼容调用，需调试时改为下面原实现并设 debug = true
    function clientLog(tag, msg, extra) {
        return; // 关闭调试输出
        /*
        if (!debug) return;
        if (extra !== undefined) {
            console.log(`[思源同步感知][${tag}] ${msg}`, extra);
        } else {
            console.log(`[思源同步感知][${tag}] ${msg}`);
        }
        */
    }

    //// 上报自己的同步状态 ////
    // syncst: 0=心跳/正常，1=我刚同步，请其他人也同步
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

    //// 拉取远端的同步状态 ////
    // 返回 { userKey, syncst, onlineCount }；syncst=1 时表示需要本地触发同步
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

    //// 启动轮询（先 push 心跳，再 pull）////
    async function startPolling() {
        // 启动时立即上报一次心跳（push syncst=0）
        heartbeatOk = await pushSyncStatus(0);
        if (!heartbeatOk) {
            console.warn('[思源同步感知] 启动心跳失败，仍将持续重试');
        }

        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            // 先 push 心跳更新 lastHeartbeat；服务端据此判断"在线"
            await pushSyncStatus(0);
            // 再 pull 检查是否有需要消费的消息
            const data = await pullSyncStatus();
            if (!data) return;
            // 记录在线数（含本机），>1 表示还有别的设备
            if (typeof data.onlineCount === 'number') {
                lastOnlineCount = data.onlineCount;
            }
            if (isRemoteSyncing) return;
            if (data.syncst === 1) {
                isRemoteSyncing = true;
                isPullTriggeredSync = true; // pull 触发的同步，不 push syncst=1
                const result = await sync();
                lastPullSyncTime = Date.now();
                if (result && result.code === 0) {
                    clientLog('SYNC', 'pull 触发同步成功');
                } else {
                    if (notifyOnSyncFailed) showErrorMessage("从远程同步失败，请手动同步");
                    // console.log('[思源同步感知] remote sync failed: ', result);
                }
                setTimeout(() => {
                    isPullTriggeredSync = false;
                    isRemoteSyncing = false;
                }, 2000);
            }
        }, pullInterval);
    }

    // 监控文件改变
    async function listenChange() {
        const originalFetch = window.fetch;
        window.fetch = async function (url, ...args) {
            try {
                const response = await originalFetch(url, ...args);
                if (syncActions.some(item => url.toString().endsWith(item))) {
                    if (siyuan.config.sync.enabled && siyuan.config.sync.provider !== 0) {
                        const otherCount = await getOtherClientCount();
                        if (otherCount > 1) {
                            if (isPullTriggeredSync) {
                                // pull 触发的同步，不做任何动作（不 push syncst=1）
                                clientLog('FETCH', 'pull 触发的同步，跳过');
                            } else if (url.toString().endsWith('/api/sync/performSync')) {
                                // 手动同步后发送感知信号
                                delaySendMessage();
                            } else {
                                // 文件变化后自动同步
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

    // 监控同步按钮被点击
    function listenSyncBtnClick() {
        const syncBtn = document.querySelector(isMobile() ? "#toolbarSync" : "#barSync svg");
        syncBtn.addEventListener("click", async function () {
            willSync(false);
        });
    }

    // 延迟发送消息，在用户手动同步后，用于通知远端客户端也同步
    function delaySendMessage() {
        if (sendMessageTimer) clearTimeout(sendMessageTimer);
        sendMessageTimer = setTimeout(async () => {
            const ok = await pushSyncStatus(1);
            if (!ok) {
                console.warn('[思源同步感知] 远端感知上报失败 appId:', siyuan.ws.app.appId);
            }
        }, autoSyncInterval * 1000);
    }

    // 延迟同步，在文件发生变化后，先本地同步，然后通知远端客户端同步
    function delaySync() {
        if (isLocalSyncing) return;
        if (isRemoteSyncing || isPullTriggeredSync) {
            // 刚完成 pull 触发的同步，不重复
            return;
        }
        // pull 触发的同步刚完成 5 秒内，不重复延迟同步
        if (Date.now() - lastPullSyncTime < 5000) return;
        // 使用独立的 syncTimer，不再与 sendMessageTimer 互抢
        if (syncTimer) clearTimeout(syncTimer);
        willSync(true);
        syncTimer = setTimeout(async () => {
            willSync(false);
            try {
                isLocalSyncing = true;
                const result = await sync();
                isLocalSyncing = false;
                if (result && result.code === 0) {
                    // 本地主动同步成功 → push syncst=1 通知其他设备消费
                    await pushSyncStatus(1);
                    clientLog('SYNC', '本地同步成功，已 push syncst=1');
                } else {
                    if (notifyOnSyncFailed) showErrorMessage("本地同步失败，请手动同步");
                    // console.log('[思源同步感知] local sync failed: ', result);
                }
            } catch (e) {
                isLocalSyncing = false;
                // console.log('[思源同步感知] local sync error: ', e);
            }
        }, autoSyncInterval * 1000);
    }

    // 调用同步api
    async function sync(payload = {}) {
        return await fetchSyncPost('/api/sync/performSync?by=sync-js', payload || {});
    }

    // 即将开始同步
    function willSync(yes = true) {
        const syncBtn = document.querySelector(isMobile() ? "#toolbarSync" : "#barSync svg");
        if (yes) {
            if (syncBtn) syncBtn.style.color = 'red';
        } else {
            if (syncBtn) syncBtn.style.color = '';
        }
    }

    // 显示通知
    function showErrorMessage(message, delay) {
        fetchSyncPost("/api/notification/pushErrMsg", {
            "msg": message,
            "timeout": delay || 7000
        });
    }

    // 请求api
    async function fetchSyncPost(url, data, returnType = 'json') {
        const init = {
            method: "POST",
        };
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
            // console.log(e);
            return returnType === 'json' ? { code: e.code || 1, msg: e.message || "", data: null } : "";
        }
    }

    // 加密数据（保留以备扩展）
    function encrypt(key, data) {
        let encrypted = '';
        for (let i = 0; i < data.length; i++) {
          const charCode = data.charCodeAt(i) ^ key.charCodeAt(i % key.length);
          encrypted += String.fromCharCode(charCode);
        }
        return btoa(encrypted);
    }

    // 解密数据（保留以备扩展）
    function decrypt(key, encryptedData) {
        const decryptedData = atob(encryptedData);
        let decrypted = '';
        for (let i = 0; i < decryptedData.length; i++) {
          const charCode = decryptedData.charCodeAt(i) ^ key.charCodeAt(i % key.length);
          decrypted += String.fromCharCode(charCode);
        }
        return decrypted;
    }

    // 是否手机版
    function isMobile() {
        return document.getElementById("sidebar") ? true : false;
    }

    // 调试信息（日志已禁用）
    function debugInfo(msg1, msg2, msg3, msg4, msg5) {
        return; // 关闭调试输出
        // if (debug) console.log(msg1, msg2, msg3);
    }

    // 获取其他客户端数量（基于上次 pull 返回的 onlineCount）
    let lastOnlineCount = 2; // 默认按"多端"处理，保证自动同步可用
    async function getOtherClientCount() {
        // pull 返回的 onlineCount 包含自己，>1 即有多端
        return lastOnlineCount > 1 ? lastOnlineCount : 2;
    }

    /////////////////// 启动 /////////////////////////////

    // 启动轮询（异步内部完成首次心跳）
    startPolling();

    // 监控文件改变
    listenChange();

    // 监控同步按钮被点击
    listenSyncBtnClick();

    // debugInfo("[思源同步感知] v0.2.0 (3端改造) 已启动: " + serverUrl, "userKey=", genUserKey());

})();