// 功能：思源同步感知（自建感知节点版）
// 基于 muhanstudio/siyuan-sync-aware-serve，无须注册 GoEasy
// 服务端协议：HTTP POST /，Header: userKey + action(push/pull)，Body: {syncst}
// version 0.1.2
// 更新记录
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
    console.log('[思源同步感知] 脚本加载中...');

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

    // 定义调试模式
    const debug = true;

    //// 定义全局变量 ////
    // 拆分为两个独立 timer，避免手动同步与编辑同步互相干扰
    let sendMessageTimer = null,
        syncTimer = null,
        isRemoteSyncing = false,
        isLocalSyncing = false,
        isPullTriggeredSync = false,
        lastPullSyncTime = 0,  // 记录 pull 触发同步的完成时间
        pollTimer = null;

    // 生成 userKey，同一仓库的所有客户端保持一致
    // 仅使用 repoKey，确保同一仓库的所有设备共享相同的 userKey
    // 原版使用 appId + repoKey 会导致不同设备的 userKey 不同，B端永远无法感知A端的更新
    function genUserKey() {
        const repoKey = siyuan.config.repo.key;
        return encodeURIComponent(repoKey);
    }

    //// 上报自己的同步状态 ////
    // syncst: 0=正常，1=我刚同步，请其他人也同步
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
            return res.ok;
        } catch (e) {
            console.warn('pushSyncStatus failed: ', e);
            return false;
        }
    }

    //// 拉取远端的同步状态 ////
    // 返回 { userKey, syncst }；当 syncst=1 时表示需要本地触发同步
    // 同时服务端会清掉自己上次的 push 记录
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
                console.warn('[PULL] 请求失败:', res.status);
                return null;
            }
            const text = await res.text();
            try {
                const data = JSON.parse(text);
                return data;
            } catch (e) {
                // 服务端可能返回了纯文本（如健康检查路由），防御性处理
                return null;
            }
        } catch (e) {
            console.warn('[PULL] failed: ', e);
            return null;
        }
    }

    //// 拉取 data.json 内容，统计在线客户端数 ////
    // 服务端没有专门的 hereNow 接口，我们通过 GET / 的诊断接口配合解析
    // 不过这个接口只返回 "感知节点正常运行中" 文本，不返回 data.json 内容
    // 所以这里改为：直接通过连续两次 pull 的 userKey 是否变回来判断"是否有其他客户端"
    // 简化方案：维持一个本地最近pull结果缓存，发现 syncst=1 就触发同步；不算在线数
    // 注意：原版 0.0.6 的"仅当有两个及以上客户端同时在线时才同步"这一优化在自建版本里无法精确实现
    //     因为服务端不返回"其他用户列表"。但不影响核心功能：只要对方 push 过 syncst=1 就同步
    async function getOtherClientCount() {
        // 自建服务不暴露 hereNow，固定返回 2（>=1 即视为有多端）以保留原版自动同步行为
        // 如果你想只在真正多端时同步，可以把这里改为判断"上一次 pull 是否有非本机记录"
        // 但 pull 接口的协议无法区分（本机会被自动清掉），所以简化为始终 >= 1
        return 2;
    }

    // 启动轮询
    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(async () => {
            // 先 pull 再判断，避免 sync 进行中丢消息
            const data = await pullSyncStatus();
            if (isRemoteSyncing) return;
            // 服务端采用"读后即清"语义，拉到 syncst=1 就是别人留的（不会被重复消费）
            if (data && data.syncst === 1) {
                isRemoteSyncing = true;
                isPullTriggeredSync = true; // 标记为 pull 触发的同步
                const result = await sync();
                lastPullSyncTime = Date.now(); // 记录完成时间
                if (result && result.code === 0) {
                    debugInfo('收到远端同步信号，已同步成功');
                } else {
                    if (notifyOnSyncFailed) showErrorMessage("从远程同步失败，请手动同步");
                    console.log('remote sync failed: ', result);
                }
                // 延迟重置标记，避免 listenChange 在同步刚完成后被触发
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
                                // pull 触发的同步，不做任何动作
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
                console.warn('远端感知上报失败 appId:', siyuan.ws.app.appId);
            }
            // 不再主动 pull：服务端采用"读后即清"语义，主动 pull 会抢占对端的消息
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
                    // 同步成功后 push 告诉对端；不要主动 pull，避免抢走对端应消费的消息
                    await pushSyncStatus(1);
                } else {
                    if (notifyOnSyncFailed) showErrorMessage("本地同步失败，请手动同步");
                    console.log('local sync failed: ', result);
                }
            } catch (e) {
                isLocalSyncing = false;
                console.log('local sync error: ', e);
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
            console.log(e);
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

    // 调试信息
    function debugInfo(msg1, msg2, msg3, msg4, msg5) {
        if (debug) console.log(msg1, msg2, msg3);
    }

    /////////////////// 启动 /////////////////////////////

    // 启动轮询
    startPolling();

    // 监控文件改变
    listenChange();

    // 监控同步按钮被点击
    listenSyncBtnClick();

    debugInfo("自建同步感知节点已启动: " + serverUrl);

})();