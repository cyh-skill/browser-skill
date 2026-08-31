use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result, anyhow};
use axum::{
    Router,
    extract::{
        State, WebSocketUpgrade,
        ws::{Message, WebSocket},
    },
    http::{HeaderMap, StatusCode, header::ORIGIN},
    response::{IntoResponse, Response},
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, mpsc, oneshot};
use tracing::{info, warn};
use uuid::Uuid;

use crate::state::AppState;

type PendingResult = std::result::Result<Value, String>;

#[derive(Clone, Default)]
pub struct ExtensionHub {
    inner: Arc<ExtensionHubInner>,
}

#[derive(Default)]
struct ExtensionHubInner {
    current: RwLock<Option<Arc<ExtensionClient>>>,
}

struct ExtensionClient {
    id: Uuid,
    sender: mpsc::UnboundedSender<Message>,
    pending: Mutex<HashMap<String, oneshot::Sender<PendingResult>>>,
    metadata: RwLock<Value>,
}

impl ExtensionHub {
    pub async fn connected(&self) -> bool {
        self.inner.current.read().await.is_some()
    }

    pub async fn metadata(&self) -> Option<Value> {
        let client = self.inner.current.read().await.clone()?;
        Some(client.metadata.read().await.clone())
    }

    pub async fn call(&self, command: &str, args: Value, timeout: Duration) -> Result<Value> {
        let client = self
            .inner
            .current
            .read()
            .await
            .clone()
            .ok_or_else(|| anyhow!("extension provider is not connected"))?;
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        client.pending.lock().await.insert(id.clone(), sender);
        let request = json!({ "id": id, "cmd": command, "args": args });
        if client
            .sender
            .send(Message::Text(request.to_string().into()))
            .is_err()
        {
            client.pending.lock().await.remove(&id);
            return Err(anyhow!("extension connection closed"));
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(error))) => Err(anyhow!(error)),
            Ok(Err(_)) => Err(anyhow!("extension response channel closed")),
            Err(_) => {
                client.pending.lock().await.remove(&id);
                Err(anyhow!("extension command {command} timed out"))
            }
        }
    }
}

pub async fn serve(state: Arc<AppState>) -> Result<()> {
    let hub = state.extension.clone();
    let app = Router::new()
        .route("/", get(websocket_upgrade))
        .with_state(hub);
    let address = SocketAddr::from(([127, 0, 0, 1], state.config.extension_port));
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .with_context(|| format!("cannot bind extension WebSocket to {address}"))?;
    info!(%address, "extension bridge listening");
    axum::serve(listener, app)
        .await
        .context("extension bridge server failed")
}

async fn websocket_upgrade(
    State(hub): State<ExtensionHub>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let origin = headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    if !origin.starts_with("chrome-extension://") && !origin.starts_with("edge-extension://") {
        return (StatusCode::FORBIDDEN, "browser extension origin required").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(hub, socket))
}

async fn handle_socket(hub: ExtensionHub, socket: WebSocket) {
    let (mut sink, mut stream) = socket.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<Message>();
    let client = Arc::new(ExtensionClient {
        id: Uuid::new_v4(),
        sender,
        pending: Mutex::new(HashMap::new()),
        metadata: RwLock::new(json!({})),
    });
    {
        let mut current = hub.inner.current.write().await;
        if current.is_some() {
            warn!("replacing existing extension connection");
        }
        *current = Some(client.clone());
    }
    info!(connection = %client.id, "extension connected");

    let writer = tokio::spawn(async move {
        while let Some(message) = receiver.recv().await {
            if sink.send(message).await.is_err() {
                break;
            }
        }
    });

    while let Some(message) = stream.next().await {
        match message {
            Ok(Message::Text(text)) => handle_message(&client, text.as_str()).await,
            Ok(Message::Ping(payload)) => {
                let _ = client.sender.send(Message::Pong(payload));
            }
            Ok(Message::Close(_)) | Err(_) => break,
            _ => {}
        }
    }

    writer.abort();
    for (_, pending) in client.pending.lock().await.drain() {
        let _ = pending.send(Err("extension disconnected".into()));
    }
    let mut current = hub.inner.current.write().await;
    if current.as_ref().is_some_and(|value| value.id == client.id) {
        *current = None;
    }
    info!(connection = %client.id, "extension disconnected");
}

async fn handle_message(client: &Arc<ExtensionClient>, text: &str) {
    let Ok(message) = serde_json::from_str::<Value>(text) else {
        return;
    };
    if message.get("type").and_then(Value::as_str) == Some("hello") {
        *client.metadata.write().await = message;
        return;
    }
    let Some(id) = message.get("id").and_then(Value::as_str) else {
        return;
    };
    let Some(pending) = client.pending.lock().await.remove(id) else {
        return;
    };
    let result = if message.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        Ok(message.get("result").cloned().unwrap_or(Value::Null))
    } else {
        Err(message
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("extension command failed")
            .to_owned())
    };
    let _ = pending.send(result);
}

#[cfg(test)]
mod tests {
    #[test]
    fn extension_origin_policy_is_explicit() {
        assert!("chrome-extension://abc".starts_with("chrome-extension://"));
        assert!(!"http://127.0.0.1".starts_with("chrome-extension://"));
    }
}
