use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, anyhow, bail};
use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, mpsc, oneshot};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{info, warn};
use uuid::Uuid;

use crate::state::{AppState, RuntimeConfig};

type PendingResult = std::result::Result<Value, String>;

#[derive(Clone, Default)]
pub struct CdpHub {
    inner: Arc<CdpHubInner>,
}

#[derive(Default)]
struct CdpHubInner {
    current: RwLock<Option<Arc<CdpConnection>>>,
    sessions: Mutex<HashMap<String, String>>,
    rules: RwLock<Vec<NetworkRule>>,
    last_error: RwLock<Option<String>>,
}

struct CdpConnection {
    id: Uuid,
    sender: mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<u64, oneshot::Sender<PendingResult>>>,
    sequence: AtomicU64,
    endpoint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum NetworkRule {
    Block {
        #[serde(rename = "targetId")]
        target_id: String,
        pattern: String,
    },
    Rewrite {
        #[serde(rename = "targetId")]
        target_id: String,
        pattern: String,
        redirect_url: String,
    },
    Mock {
        #[serde(rename = "targetId")]
        target_id: String,
        pattern: String,
        #[serde(default = "default_status")]
        status: u16,
        #[serde(default = "default_content_type")]
        content_type: String,
        #[serde(default)]
        body: String,
    },
}

fn default_status() -> u16 {
    200
}
fn default_content_type() -> String {
    "application/json; charset=utf-8".into()
}

impl CdpHub {
    pub async fn connected(&self) -> bool {
        self.inner.current.read().await.is_some()
    }

    pub async fn endpoint(&self) -> Option<String> {
        self.inner
            .current
            .read()
            .await
            .as_ref()
            .map(|value| value.endpoint.clone())
    }

    pub async fn last_error(&self) -> Option<String> {
        self.inner.last_error.read().await.clone()
    }

    pub async fn connect(&self, endpoint: String) -> Result<()> {
        let (socket, _) = connect_async(endpoint.as_str())
            .await
            .with_context(|| format!("cannot connect to CDP endpoint {endpoint}"))?;
        let (mut sink, mut stream) = socket.split();
        let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
        let connection = Arc::new(CdpConnection {
            id: Uuid::new_v4(),
            sender,
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            endpoint: endpoint.clone(),
        });
        *self.inner.current.write().await = Some(connection.clone());
        *self.inner.last_error.write().await = None;
        self.inner.sessions.lock().await.clear();
        info!(%endpoint, "CDP sidecar connected");

        let writer = tokio::spawn(async move {
            while let Some(message) = receiver.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
        });
        let hub = self.clone();
        tokio::spawn(async move {
            while let Some(message) = stream.next().await {
                match message {
                    Ok(Message::Text(text)) => hub.handle_message(&connection, text.as_str()).await,
                    Ok(Message::Ping(payload)) => {
                        let _ = connection.sender.send(Message::Pong(payload));
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            writer.abort();
            for (_, pending) in connection.pending.lock().await.drain() {
                let _ = pending.send(Err("CDP connection closed".into()));
            }
            let mut current = hub.inner.current.write().await;
            if current
                .as_ref()
                .is_some_and(|value| value.id == connection.id)
            {
                *current = None;
            }
            hub.inner.sessions.lock().await.clear();
            warn!(%endpoint, "CDP sidecar disconnected");
        });
        Ok(())
    }

    pub async fn call(
        &self,
        method: &str,
        params: Value,
        session_id: Option<&str>,
    ) -> Result<Value> {
        let connection = self
            .inner
            .current
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("CDP provider is not connected"))?;
        let id = connection.sequence.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        connection.pending.lock().await.insert(id, sender);
        let mut request = json!({ "id": id, "method": method, "params": params });
        if let Some(session_id) = session_id {
            request["sessionId"] = Value::String(session_id.to_owned());
        }
        if connection
            .sender
            .send(Message::Text(request.to_string().into()))
            .is_err()
        {
            connection.pending.lock().await.remove(&id);
            bail!("CDP connection closed");
        }
        match tokio::time::timeout(Duration::from_secs(20), receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("CDP response channel closed")),
            Err(_) => {
                connection.pending.lock().await.remove(&id);
                Err(anyhow!("CDP command {method} timed out"))
            }
        }
    }

    pub async fn targets(&self) -> Result<Vec<Value>> {
        let result = self.call("Target.getTargets", json!({}), None).await?;
        Ok(result
            .get("targetInfos")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    pub async fn create_target(&self, url: &str) -> Result<String> {
        let result = self
            .call(
                "Target.createTarget",
                json!({ "url": url, "background": true }),
                None,
            )
            .await?;
        result
            .get("targetId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| anyhow!("CDP did not return targetId"))
    }

    pub async fn close_target(&self, target_id: &str) -> Result<Value> {
        self.inner.sessions.lock().await.remove(target_id);
        self.call("Target.closeTarget", json!({ "targetId": target_id }), None)
            .await
    }

    pub async fn detach_target(&self, target_id: &str) -> Result<()> {
        if let Some(session_id) = self.inner.sessions.lock().await.remove(target_id) {
            self.call(
                "Target.detachFromTarget",
                json!({ "sessionId": session_id }),
                None,
            )
            .await?;
        }
        Ok(())
    }

    pub async fn session_for(&self, target_id: &str) -> Result<String> {
        if let Some(session) = self.inner.sessions.lock().await.get(target_id).cloned() {
            return Ok(session);
        }
        let result = self
            .call(
                "Target.attachToTarget",
                json!({ "targetId": target_id, "flatten": true }),
                None,
            )
            .await?;
        let session = result
            .get("sessionId")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .ok_or_else(|| anyhow!("CDP did not return sessionId"))?;
        self.inner
            .sessions
            .lock()
            .await
            .insert(target_id.to_owned(), session.clone());
        self.call("Runtime.enable", json!({}), Some(&session))
            .await
            .ok();
        self.call("Page.enable", json!({}), Some(&session))
            .await
            .ok();
        self.call("Network.enable", json!({}), Some(&session))
            .await
            .ok();
        if self
            .inner
            .rules
            .read()
            .await
            .iter()
            .any(|rule| rule_target(rule) == target_id)
        {
            self.call(
                "Fetch.enable",
                json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] }),
                Some(&session),
            )
            .await?;
        }
        Ok(session)
    }

    pub async fn evaluate(&self, target_id: &str, expression: &str) -> Result<Value> {
        let session = self.session_for(target_id).await?;
        let result = self
            .call(
                "Runtime.evaluate",
                json!({
                    "expression": expression,
                    "returnByValue": true,
                    "awaitPromise": true,
                    "userGesture": true
                }),
                Some(&session),
            )
            .await?;
        if let Some(exception) = result.get("exceptionDetails") {
            bail!("JavaScript evaluation failed: {exception}");
        }
        Ok(result
            .pointer("/result/value")
            .cloned()
            .unwrap_or(Value::Null))
    }

    pub async fn target_command(
        &self,
        target_id: &str,
        method: &str,
        params: Value,
    ) -> Result<Value> {
        let session = self.session_for(target_id).await?;
        self.call(method, params, Some(&session)).await
    }

    pub async fn add_rule(&self, rule: NetworkRule) -> Result<()> {
        let session = self.session_for(rule_target(&rule)).await?;
        self.call(
            "Fetch.enable",
            json!({ "patterns": [{ "urlPattern": "*", "requestStage": "Request" }] }),
            Some(&session),
        )
        .await?;
        self.inner.rules.write().await.push(rule);
        Ok(())
    }

    pub async fn rules(&self) -> Vec<NetworkRule> {
        self.inner.rules.read().await.clone()
    }

    pub async fn clear_rules(&self) -> Result<()> {
        self.inner.rules.write().await.clear();
        let sessions = self
            .inner
            .sessions
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for session in sessions {
            self.call("Fetch.disable", json!({}), Some(&session))
                .await
                .ok();
        }
        Ok(())
    }

    async fn handle_message(&self, connection: &Arc<CdpConnection>, text: &str) {
        let Ok(message) = serde_json::from_str::<Value>(text) else {
            return;
        };
        if let Some(id) = message.get("id").and_then(Value::as_u64) {
            let Some(pending) = connection.pending.lock().await.remove(&id) else {
                return;
            };
            let result = if let Some(error) = message.get("error") {
                Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("CDP command failed")
                    .to_owned())
            } else {
                Ok(message.get("result").cloned().unwrap_or(Value::Null))
            };
            let _ = pending.send(result);
            return;
        }
        if message.get("method").and_then(Value::as_str) == Some("Fetch.requestPaused") {
            let hub = self.clone();
            tokio::spawn(async move {
                hub.handle_fetch_event(message).await;
            });
        }
    }

    async fn handle_fetch_event(&self, event: Value) {
        let Some(session) = event.get("sessionId").and_then(Value::as_str) else {
            return;
        };
        let Some(request_id) = event.pointer("/params/requestId").and_then(Value::as_str) else {
            return;
        };
        let url = event
            .pointer("/params/request/url")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let target = self
            .inner
            .sessions
            .lock()
            .await
            .iter()
            .find_map(|(target, candidate)| (candidate == session).then(|| target.clone()));
        let rule = if let Some(target) = target.as_deref() {
            self.inner
                .rules
                .read()
                .await
                .iter()
                .find(|rule| rule_target(rule) == target && wildcard_match(rule_pattern(rule), url))
                .cloned()
        } else {
            None
        };
        let (method, params) = match rule {
            Some(NetworkRule::Block { .. }) => (
                "Fetch.failRequest",
                json!({ "requestId": request_id, "errorReason": "BlockedByClient" }),
            ),
            Some(NetworkRule::Rewrite { redirect_url, .. }) => (
                "Fetch.continueRequest",
                json!({ "requestId": request_id, "url": redirect_url }),
            ),
            Some(NetworkRule::Mock {
                status,
                content_type,
                body,
                ..
            }) => (
                "Fetch.fulfillRequest",
                json!({
                    "requestId": request_id,
                    "responseCode": status,
                    "responseHeaders": [{ "name": "Content-Type", "value": content_type }],
                    "body": base64::engine::general_purpose::STANDARD.encode(body.as_bytes())
                }),
            ),
            None => ("Fetch.continueRequest", json!({ "requestId": request_id })),
        };
        self.call(method, params, Some(session)).await.ok();
    }
}

pub fn spawn_reconnector(state: Arc<AppState>) {
    tokio::spawn(async move {
        loop {
            if !state.cdp.connected().await {
                match discover_endpoint(&state.config).await {
                    Ok(Some(endpoint)) => {
                        if let Err(error) = state.cdp.connect(endpoint).await {
                            *state.cdp.inner.last_error.write().await = Some(error.to_string());
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        *state.cdp.inner.last_error.write().await = Some(error.to_string())
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

pub async fn doctor(config: &RuntimeConfig) -> Value {
    match discover_endpoint(config).await {
        Ok(Some(endpoint)) => json!({ "available": true, "endpoint": endpoint }),
        Ok(None) => {
            json!({ "available": false, "hint": "enable remote debugging or set BROWSER_SKILL_CDP_ENDPOINT" })
        }
        Err(error) => json!({ "available": false, "error": error.to_string() }),
    }
}

pub async fn discover_endpoint(config: &RuntimeConfig) -> Result<Option<String>> {
    if let Some(endpoint) = config.cdp_endpoint.as_deref() {
        return normalize_endpoint(endpoint).await.map(Some);
    }
    let candidates = browser_candidates();
    let filtered = candidates
        .into_iter()
        .filter(|(id, _)| {
            config
                .browser
                .as_deref()
                .is_none_or(|browser| browser == id)
        })
        .collect::<Vec<_>>();
    let mut detected = Vec::new();
    for (id, path) in filtered {
        if let Ok(content) = tokio::fs::read_to_string(&path).await {
            let mut lines = content.lines();
            let Some(port) = lines.next().and_then(|value| value.parse::<u16>().ok()) else {
                continue;
            };
            let ws_path = lines.next().unwrap_or("/devtools/browser");
            detected.push((id, format!("ws://127.0.0.1:{port}{ws_path}")));
        }
    }
    if detected.len() > 1 && config.browser.is_none() {
        bail!("multiple CDP browsers detected; set BROWSER_SKILL_BROWSER");
    }
    if let Some((_, endpoint)) = detected.into_iter().next() {
        return Ok(Some(endpoint));
    }
    for port in [9222_u16, 9229, 9333] {
        if let Ok(endpoint) = normalize_endpoint(&format!("http://127.0.0.1:{port}")).await {
            return Ok(Some(endpoint));
        }
    }
    Ok(None)
}

async fn normalize_endpoint(endpoint: &str) -> Result<String> {
    if endpoint.starts_with("ws://") || endpoint.starts_with("wss://") {
        return Ok(endpoint.to_owned());
    }
    let base = endpoint.trim_end_matches('/');
    let response = reqwest::Client::new()
        .get(format!("{base}/json/version"))
        .timeout(Duration::from_secs(1))
        .send()
        .await?
        .error_for_status()?;
    let value: Value = response.json().await?;
    value
        .get("webSocketDebuggerUrl")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("{base}/json/version did not return webSocketDebuggerUrl"))
}

fn browser_candidates() -> Vec<(String, PathBuf)> {
    let home = dirs::home_dir().unwrap_or_default();
    #[cfg(target_os = "macos")]
    let values = vec![
        (
            "chrome",
            "Library/Application Support/Google/Chrome/DevToolsActivePort",
        ),
        (
            "chrome-canary",
            "Library/Application Support/Google/Chrome Canary/DevToolsActivePort",
        ),
        (
            "chromium",
            "Library/Application Support/Chromium/DevToolsActivePort",
        ),
        (
            "edge",
            "Library/Application Support/Microsoft Edge/DevToolsActivePort",
        ),
    ];
    #[cfg(target_os = "linux")]
    let values = vec![
        ("chrome", ".config/google-chrome/DevToolsActivePort"),
        ("chromium", ".config/chromium/DevToolsActivePort"),
        ("edge", ".config/microsoft-edge/DevToolsActivePort"),
    ];
    #[cfg(target_os = "windows")]
    let values = {
        let local = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_default();
        return vec![
            (
                "chrome".into(),
                local.join("Google/Chrome/User Data/DevToolsActivePort"),
            ),
            (
                "chromium".into(),
                local.join("Chromium/User Data/DevToolsActivePort"),
            ),
            (
                "edge".into(),
                local.join("Microsoft/Edge/User Data/DevToolsActivePort"),
            ),
        ];
    };
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let values: Vec<(&str, &str)> = vec![];
    values
        .into_iter()
        .map(|(id, path)| (id.into(), home.join(path)))
        .collect()
}

fn rule_pattern(rule: &NetworkRule) -> &str {
    match rule {
        NetworkRule::Block { pattern, .. }
        | NetworkRule::Rewrite { pattern, .. }
        | NetworkRule::Mock { pattern, .. } => pattern,
    }
}

fn rule_target(rule: &NetworkRule) -> &str {
    match rule {
        NetworkRule::Block { target_id, .. }
        | NetworkRule::Rewrite { target_id, .. }
        | NetworkRule::Mock { target_id, .. } => target_id,
    }
}

fn wildcard_match(pattern: &str, value: &str) -> bool {
    let (mut p, mut v, mut star, mut mark) = (0, 0, None, 0);
    let pattern = pattern.as_bytes();
    let value = value.as_bytes();
    while v < value.len() {
        if p < pattern.len() && (pattern[p] == b'?' || pattern[p] == value[v]) {
            p += 1;
            v += 1;
        } else if p < pattern.len() && pattern[p] == b'*' {
            star = Some(p);
            p += 1;
            mark = v;
        } else if let Some(star_index) = star {
            p = star_index + 1;
            mark += 1;
            v = mark;
        } else {
            return false;
        }
    }
    while p < pattern.len() && pattern[p] == b'*' {
        p += 1;
    }
    p == pattern.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_matching_covers_network_rules() {
        assert!(wildcard_match(
            "*://*.example.com/*",
            "https://api.example.com/a"
        ));
        assert!(!wildcard_match(
            "*://*.example.com/*",
            "https://example.org/a"
        ));
    }
}
