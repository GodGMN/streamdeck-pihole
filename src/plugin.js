import * as http from "http";
import * as https from "https";
import streamDeck, { LogLevel, SingletonAction } from "@elgato/streamdeck";

streamDeck.logger.setLevel(LogLevel.INFO);
var instances = {}
var sessionCache = {}

// Helper function to make HTTP/HTTPS requests
function sendRequest(method, url, headers = {}, body = null, handler, allowInsecure = false){
    const urlObj = new URL(url);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    if (body && typeof body === 'object') {
        headers['Content-Type'] = 'application/json';
    }

    const options = {
        method: method,
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        headers: headers,
        timeout: 30000
    };
    
    if (isHttps && allowInsecure) {
        options.agent = new https.Agent({
            rejectUnauthorized: false
        });
    }
    
    const req = client.request(options, (res) => {
        let data = '';
        
        res.on('data', (chunk) => {
            data += chunk;
        });
        
        res.on('end', () => {
            if (res.statusCode === 401) {
                handler({ error: "Unauthorized", code: 401 });
                return;
            }

            try {
                const parsed = JSON.parse(data);
                handler(parsed);
            } catch (e) {
                handler({ error: "Invalid JSON response" });
            }
        });
    });
    
    req.on('error', (err) => {
        handler({ error: err.message || "Network error" });
    });
    
    req.on('timeout', () => {
        req.destroy();
        handler({ error: "Request timeout" });
    });
    
    if (body) {
        req.write(JSON.stringify(body));
    }
    
    req.end();
}

// send message to Property Inspector
function sendToPropertyInspector(_context, payload){
    streamDeck.ui.current?.sendToPropertyInspector(payload);
}

// get auth token from pi-hole API that is valid until 30 min of inactivity
function pihole_connect({ settings, session }, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/auth`;
    streamDeck.logger.debug(`POST request to ${req_addr}`);
    
    if (session == null || session.valid === false){
        sendRequest('POST', req_addr, {}, { password: settings.ph_key }, handler, settings.allow_insecure);
    } else{
        sendRequest('GET', req_addr, {
            'X-FTL-SID': session.sid
        }, null, response => {
            if ("error" in response && response.code === 401){
                sendRequest('POST', req_addr, {}, { password: settings.ph_key }, handler, settings.allow_insecure);
            } else{
                streamDeck.logger.debug("reusing existing session");
                handler(response);
            }
        }, settings.allow_insecure);
    }
}

// delete pi-hole session since API seats are limited
function pihole_end({ settings, session }){
    if (session == null) return;
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/auth`;
    streamDeck.logger.debug(`DELETE request to ${req_addr}`);

    session.valid = false;
    sendRequest('DELETE', req_addr, {
        'X-FTL-SID': session.sid
    }, null, () => {}, settings.allow_insecure);
}

// make a call to check if pi-hole is enabled
function getBlockingStatus(settings, session, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/dns/blocking`;
    streamDeck.logger.debug(`GET request to ${req_addr}`);
    
    sendRequest('GET', req_addr, {
        'X-FTL-SID': session.sid
    }, null, handler, settings.allow_insecure);
}

// make a call to enable or disable pi-hole
function setBlockingStatus(settings, session, enabled, timer){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/dns/blocking`;
    streamDeck.logger.debug(`POST request to ${req_addr}`);
    
    sendRequest('POST', req_addr, {
        'X-FTL-SID': session.sid
    }, { blocking: enabled, timer }, () => {}, settings.allow_insecure);
}

// get stats for the pi-hole (# queries, # clients, etc.) and pass to a handler function
function getStatsSummary(settings, session, handler){
    let req_addr = `${settings.protocol}://${settings.ph_addr}/api/stats/summary`;
    streamDeck.logger.debug(`GET request to ${req_addr}`);
    
    sendRequest('GET', req_addr, {
        'X-FTL-SID': session.sid
    }, null, handler, settings.allow_insecure);
}

// event handler for us.johnholbrook.pihole.temporarily-disable
function temporarily_disable(context){
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        if (response.blocking == "enabled"){  // it only makes sense to temporarily disable p-h if it's currently enabled
            setBlockingStatus(settings, session, false, parseInt(settings.disable_time))
        }
    });
}

// event handler for us.johnholbrook.pihole.toggle
function toggle(context){
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        if (response.blocking == "disabled"){
            setBlockingStatus(settings, session, true);
            setState(context, 0);
        }
        else if (response.blocking == "enabled"){
            setBlockingStatus(settings, session, false);
            setState(context, 1);
        }
    });
}

// event handler for us.johnholbrook.pihole.disable
function disable(context){
    let { settings, session } = instances[context];
    setBlockingStatus(settings, session, false);
}

// event handler for us.johnholbrook.pihole.enable
function enable(context){
    let { settings, session } = instances[context];
    setBlockingStatus(settings, session, true);
}

// poll p-h and set the state and button text appropriately
// (called once per second per instance)
function pollPihole(context){
    let { settings, session } = instances[context];
    getBlockingStatus(settings, session, response => {
        streamDeck.logger.debug(`response: ${JSON.stringify(response)}`)
        if ("error" in response){ // couldn't reach p-h, display a warning
            streamDeck.logger.debug(`${instances[context].action} error`)
            streamDeck.actions.getActionById(context)?.showAlert();
            streamDeck.logger.error(response);
        }
        else{
            // set state according to whether p-h is enabled or disabled
            if (response.blocking == "disabled" && settings.show_status){
                streamDeck.logger.debug(`${instances[context].action} offline`);
                streamDeck.actions.getActionById(context)?.setState(1);
            }
            else if (response.blocking == "enabled" && settings.show_status){
                streamDeck.logger.debug(`${instances[context].action} online`);
                streamDeck.actions.getActionById(context)?.setState(0);
            }

            // display stat, if desired
            if (settings.stat != "none"){
                getStatsSummary(settings, session, response => {
                    streamDeck.logger.debug(`response: ${JSON.stringify(response)}`)
                    if ("error" in response){
                        streamDeck.actions.getActionById(context)?.showAlert();
                        streamDeck.logger.error(response);
                    }
                    else{
                        // let stat = String(response[settings.stat]);
                        let stat = process_stat(response, settings.stat);
                        streamDeck.logger.debug(`${settings.stat}: ${stat}`);
                        streamDeck.actions.getActionById(context)?.setTitle(stat);
                    }
                });
            }
        }
    });
}

// process the pi-hole stats to make them more human-readable,
// then cast to string
function process_stat(stats, type){
    switch (type){
        case "domains_being_blocked":
            return stats.gravity.domains_being_blocked.toLocaleString();
        case "dns_queries_today":
            return stats.queries.total.toLocaleString();
        case "ads_blocked_today":
            return stats.queries.blocked.toLocaleString();
        case "ads_percentage_today":
            return stats.queries.percent_blocked.toFixed(2) + "%";
        case "unique_domains":
            return stats.queries.unique_domains.toLocaleString();
        case "queries_forwarded":
            return stats.queries.forwarded.toLocaleString();
        case "queries_cached":
            return stats.queries.cached.toLocaleString();
        case "clients_ever_seen":
            return stats.clients.total.toLocaleString();
        case "unique_clients":
            return stats.clients.active.toLocaleString();
    }
}

function loadSessionCache(context, globalSettings){
    if (globalSettings && "sessions" in globalSettings){
        sessionCache = globalSettings.sessions;
    }
    if (sessionCache[context] && !("session" in instances[context])){
        instances[context].session = { sid: sessionCache[context] };
        delete sessionCache[context];
    }
}

function saveSessionCache(context){
    sessionCache[context] = instances[context].session.sid;
    streamDeck.settings.setGlobalSettings({
		sessions: sessionCache,
	});
}

// write settings
function writeSettings(context, action, settings, globalSettings){
    // write the settings
    if (!(context in instances)){ 
        instances[context] = {"action": action};
    }
    instances[context].settings = settings;
    if (instances[context].settings.ph_addr == ""){
        instances[context].settings.ph_addr = "pi.hole";
    }
    if (instances[context].settings.stat == "none"){
        streamDeck.actions.getActionById(context)?.setTitle("");
    }

    // clean up old p-h instance
    if ("poller" in instances[context]){
        clearInterval(instances[context].poller);
    }
    if (!("session" in instances[context])){
        loadSessionCache(context, globalSettings);
    }

    // poll p-h to get status
    instances[context].settings.show_status = true;
    const onReady = (response) => {
        streamDeck.logger.debug(`response: ${JSON.stringify(response)}`)
        if ("error" in response){
            streamDeck.actions.getActionById(context)?.showAlert();
            instances[context].errorState = response.error.message || response.error;
            sendToPropertyInspector(context, { error: instances[context].errorState });
            streamDeck.logger.error(response);
        } else{
            instances[context].errorState = false;
            sendToPropertyInspector(context, { success: true });
            instances[context].session = response.session;
            instances[context].poller = setInterval(() => {
                const timeNow = Math.floor(Date.now() / 1000);
                const sessionExpired = "lastUpdateTime" in instances[context] &&
                    (timeNow - instances[context].lastUpdateTime) > instances[context].session.validity;
                instances[context].lastUpdateTime = timeNow;
                if (sessionExpired){
                    streamDeck.logger.debug("session expired, reconnecting");
                    clearInterval(instances[context].poller);
                    pihole_connect(instances[context], onReady);
                } else{
                    pollPihole(context);
                }
            }, Math.ceil(response.took) * 1000);
            saveSessionCache(context);
        }
    }
    pihole_connect(instances[context], onReady);
}

// Pi-hole Stream Deck Action
class PiholeAction extends SingletonAction {
    constructor(manifestId, handler) {
        super();
        this.manifestId = manifestId;
        this.handler = handler;
    }

    async onWillAppear(ev) {
        const globalSettings = await streamDeck.settings.getGlobalSettings();
        writeSettings(ev.action.id, this.manifestId, ev.payload.settings, globalSettings);
    }
    
    onWillDisappear(ev) {
        const contextId = ev.action.id;
        if (contextId in instances){
            if ("poller" in instances[contextId]){
                clearInterval(instances[contextId].poller);
            }
            pihole_end(instances[contextId]);
            delete instances[contextId];
        }
    }
    
    onDidReceiveSettings(ev) {
        writeSettings(ev.action.id, this.manifestId, ev.payload.settings);
    }
    
    onSendToPlugin(ev) {
        const contextId = ev.action.id;
        if (ev.payload && ev.payload.action === "getErrorState"){
            // Send current error state if it exists
            if (contextId in instances){
                sendToPropertyInspector(contextId, instances[contextId].errorState ? {
                    error: instances[contextId].errorState
                } : { success: instances[contextId].errorState === false });
            }
        } else if (ev.payload && ev.payload.action === "retryConnection"){
            // Retry connection by re-initializing the instance
            if (contextId in instances){
                writeSettings(contextId, instances[contextId].action, instances[contextId].settings);
            }
        }
    }
    
    onKeyUp(ev) {
        const contextId = ev.action.id;
        this.handler(contextId);
    }
}

// Register and connect
actions = {
    "us.johnholbrook.pihole.toggle": toggle,
    "us.johnholbrook.pihole.temporarily-disable": temporarily_disable,
    "us.johnholbrook.pihole.disable": disable,
    "us.johnholbrook.pihole.enable": enable
}
for (const [id, handler] of Object.entries(actions)) {
    streamDeck.actions.registerAction(new PiholeAction(id, handler));
}
streamDeck.connect();
