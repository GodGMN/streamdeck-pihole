var websocket = null;
var action = null;
var context = null;

// send some data over the websocket
function send(data){
    websocket.send(JSON.stringify(data));
}

// called by the stream deck software when the PI is inizialized
function connectElgatoStreamDeckSocket(inPort, inPropertyInspectorUUID, inRegisterEvent, inInfo, inActionInfo){
    websocket = new WebSocket(`ws://127.0.0.1:${inPort}`);
    websocket.onopen = function(){
        send({
            "event" : inRegisterEvent,
            "uuid" : inPropertyInspectorUUID
        });
    }

    websocket.onmessage = function(evt){
        let jsonObj = JSON.parse(evt.data);
        let event = jsonObj.event;
        
        // Handle connection error messages from plugin
        if (event === "sendToPropertyInspector" && jsonObj.payload) {
            if (jsonObj.payload.error) {
                showConnectionError(jsonObj.payload.error);
            } else {
                hideConnectionError(jsonObj.payload.success);
            }
        }
    }

    let actionInfo = JSON.parse(inActionInfo);
    action = actionInfo.action;
    context = inPropertyInspectorUUID;

    // hide the "disable time" input if necessary
    if (action != "us.johnholbrook.pihole.temporarily-disable"){
        document.querySelector("#disable-time").style.display = "none";
    }

    // write stored settings to input boxes
    let settings = actionInfo.payload.settings;
    document.querySelector("#ph-key-input").value = settings.ph_key ? settings.ph_key : "";
    document.querySelector("#ph-addr-input").value = settings.ph_addr ? settings.ph_addr : "";
    document.querySelector("#stat-input").value = settings.stat ? settings.stat : "none";
    if (settings.protocol === "https"){
        document.querySelector("#protocol-input").value = settings.allow_insecure ? "https-2" : "https-1";
    } else{
        document.querySelector("#protocol-input").value = "http";
    }
    if (action == "us.johnholbrook.pihole.temporarily-disable"){
        document.querySelector("#disable-time-input").value = settings.disable_time ? settings.disable_time : "";
    }
}

function sendToPlugin(payload){
    send({
        "event": "sendToPlugin",
        "action": action,
        "context": context,
        "payload": payload
    });
}

function updateSettings(){
    // send({
    //     "event": "logMessage",
    //     "payload": {
    //         "message": "Hello World!"
    //     }
    // });
    hideConnectionError();
    if (action == "us.johnholbrook.pihole.temporarily-disable"){
        let disable_time = document.querySelector("#disable-time-input").value;
        let key = document.querySelector("#ph-key-input").value;
        let addr = document.querySelector("#ph-addr-input").value;
        let stat = document.querySelector("#stat-input").value;
        let protocol = document.querySelector("#protocol-input").value;
        send({
            "event" : "setSettings",
            "context" : context,
            "payload": {
                "ph_addr" : addr,
                "ph_key" : key,
                "disable_time" : disable_time,
                "stat" : stat,
                "protocol": protocol.split("-")[0],
                "allow_insecure": protocol === "https-2"
            }
        });
    }
    else{
        let key = document.querySelector("#ph-key-input").value;
        let addr = document.querySelector("#ph-addr-input").value;
        let stat = document.querySelector("#stat-input").value;
        let protocol = document.querySelector("#protocol-input").value;
        send({
            "event" : "setSettings",
            "context" : context,
            "payload": {
                "ph_addr" : addr,
                "ph_key" : key,
                "stat" : stat,
                "protocol": protocol.split("-")[0],
                "allow_insecure": protocol === "https-2"
            }
        });
    }
}

function showConnectionError(message) {
    document.querySelector("#error-message").textContent = message;
    document.querySelector("#connection-error").style.display = "block";
    document.querySelector("#connection-success").style.display = "none";
}

function hideConnectionError(success = false) {
    document.querySelector("#connection-error").style.display = "none";
    document.querySelector("#connection-success").style.display = success ? "block" : "none";
}

function retryConnection() {
    hideConnectionError();
    sendToPlugin({ action: "retryConnection" });
}

document.addEventListener("DOMContentLoaded", () => {
    // update settings when something is changed
    document.querySelector("#disable-time-input").onchange = updateSettings;
    document.querySelector("#ph-key-input").onchange = updateSettings;
    document.querySelector("#ph-addr-input").onchange = updateSettings;
    document.querySelector("#stat-input").onchange = updateSettings;
    document.querySelector("#protocol-input").onchange = updateSettings;

    // Request current error state from plugin
    setTimeout(() => sendToPlugin({ action: "getErrorState" }), 1);

    // Setup event listeners for buttons
    document.querySelector("#retry-link").addEventListener("click", function(e) {
        e.preventDefault();
        retryConnection();
    });
});