use std::{collections::HashMap, sync::Arc, time::Duration};

use axum::{
    Router,
    body::Bytes,
    extract::{Query, Request, State},
    http::{
        HeaderValue, StatusCode,
        header::{CONTENT_TYPE, HOST, ORIGIN},
    },
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use thiserror::Error;
use tower_http::trace::TraceLayer;

use crate::{
    cdp::NetworkRule,
    knowledge::{AdapterRecord, PatternWrite},
    state::{AppState, ManagedTarget, Provider},
};

const OBSERVE_JS: &str = include_str!("../runtime/observe.js");
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/route", get(route_preview))
        .route("/provider/lease", post(provider_lease))
        .route("/provider/release", post(provider_release))
        .route("/targets", get(targets))
        .route("/sessions", get(sessions))
        .route("/new", post(new_target))
        .route("/borrow", post(borrow_target))
        .route("/return", post(return_target))
        .route("/close", get(close_target).post(close_target))
        .route("/navigate", post(navigate))
        .route("/back", get(back))
        .route("/forward", get(forward))
        .route("/reload", get(reload).post(reload))
        .route("/info", get(info))
        .route("/eval", post(evaluate))
        .route("/snapshot", get(snapshot))
        .route("/observe", get(observe))
        .route("/a11y", get(a11y))
        .route("/extract", get(extract).post(extract))
        .route("/click", post(click))
        .route("/clickAt", post(click_at))
        .route("/humanClick", post(human_click))
        .route("/hover", post(hover))
        .route("/type", post(type_text))
        .route("/fill", post(fill))
        .route("/select", post(select))
        .route("/press", post(press))
        .route("/scroll", get(scroll).post(scroll))
        .route("/screenshot", get(screenshot))
        .route("/setFiles", post(set_files))
        .route("/waitForNavigation", get(wait_for_navigation))
        .route("/console", get(console_entries))
        .route("/network", get(network_entries))
        .route("/emulate", post(emulate))
        .route("/requestHelp", post(request_help))
        .route("/net/rules", get(net_rules))
        .route("/net/clear", get(net_clear).post(net_clear))
        .route("/net/block", post(net_block))
        .route("/net/mock", post(net_mock))
        .route("/net/rewrite", post(net_rewrite))
        .route("/knowledge", get(knowledge_list))
        .route("/knowledge/context", get(knowledge_context))
        .route("/knowledge/adapters", post(knowledge_put_adapter))
        .route("/knowledge/patterns", post(knowledge_put_pattern))
        .route("/knowledge/scaffold", post(knowledge_scaffold))
        .layer(middleware::from_fn(local_request_guard))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn local_request_guard(request: Request, next: Next) -> Response {
    let headers = request.headers();
    let cross_site = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value == "cross-site");
    let foreign_origin = headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|origin| {
            let host = headers
                .get(HOST)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default();
            origin != format!("http://{host}")
        });
    if cross_site || foreign_origin {
        return (
            StatusCode::FORBIDDEN,
            axum::Json(
                json!({ "error": "browser-origin requests may not control the local Runtime" }),
            ),
        )
            .into_response();
    }
    next.run(request).await
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    target: Option<String>,
    session: Option<String>,
    provider: Option<String>,
    managed: Option<u8>,
    scope: Option<String>,
    file: Option<String>,
    format: Option<String>,
    adapter: Option<String>,
    max_items: Option<u32>,
    max_text: Option<u32>,
    include_offscreen: Option<bool>,
    direction: Option<String>,
    y: Option<i64>,
    url: Option<String>,
    operation: Option<String>,
    no_focus: Option<bool>,
    timeout: Option<u64>,
}

#[derive(Debug, Error)]
enum ApiError {
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Unavailable(String),
    #[error("{0}")]
    Internal(String),
}

impl ApiError {
    fn internal(error: impl std::fmt::Display) -> Self {
        Self::Internal(error.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::Conflict(_) => StatusCode::CONFLICT,
            Self::Unavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, axum::Json(json!({ "error": self.to_string() }))).into_response()
    }
}

type ApiResult<T> = std::result::Result<T, ApiError>;

async fn health(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let extension_connected = state.extension.connected().await;
    let cdp_connected = state.cdp.connected().await;
    axum::Json(json!({
        "status": "ok",
        "channel": "rust-hybrid",
        "apiVersion": env!("CARGO_PKG_VERSION"),
        "connected": extension_connected || cdp_connected,
        "providers": {
            "extension": {
                "connected": extension_connected,
                "metadata": state.extension.metadata().await,
                "role": "primary: Agent Window, user consent, semantic observation, normal interaction"
            },
            "cdp": {
                "connected": cdp_connected,
                "endpoint": state.cdp.endpoint().await,
                "lastError": state.cdp.last_error().await,
                "role": "sidecar: network mutation, file upload, browser-level diagnostics, forced fallback"
            }
        },
        "hybrid": extension_connected && cdp_connected,
        "queuedKeys": state.queue.size().await,
        "managedTargets": state.managed.read().await.len(),
        "knowledgeDir": state.knowledge.root(),
        "features": [
            "agentWindow", "borrowConsent", "observeV2", "a11y", "elementRefs",
            "hybridRouting", "managedGuard", "targetSessionQueue", "humanInput",
            "networkIntercept", "fileUpload", "externalKnowledgeStore", "humanLoop"
        ]
    }))
}

async fn route_preview(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let operation = params.operation.as_deref().unwrap_or("navigate");
    let cdp_required = cdp_required(operation);
    let forced = parse_provider(&params)?;
    let provider = state
        .choose_provider(forced, cdp_required)
        .await
        .map_err(ApiError::Unavailable)?;
    Ok(axum::Json(json!({
        "operation": operation,
        "provider": provider,
        "reason": if cdp_required { "operation requires CDP sidecar" } else if forced.is_some() { "provider explicitly forced" } else { "extension-first automatic policy" },
        "serializedBy": [params.target.as_ref().map(|value| format!("target:{value}")), params.session.as_ref().map(|value| format!("session:{value}"))]
    })))
}

async fn provider_lease(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let requested = parse_provider(&params)?.unwrap_or(Provider::Cdp);
    if requested != Provider::Cdp {
        return Err(ApiError::BadRequest(
            "only a CDP sidecar lease can be requested explicitly".into(),
        ));
    }
    let _guard = acquire_target_guard(&state, &params).await;
    let cdp_target = lease_to_cdp(&state, &target).await?;
    Ok(axum::Json(
        json!({ "targetId": target, "cdpTargetId": cdp_target, "provider": "cdp", "leased": true }),
    ))
}

async fn provider_release(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let _guard = acquire_target_guard(&state, &params).await;
    let managed = ensure_managed_target(&state, &target).await?;
    if managed.primary_provider == Provider::Cdp {
        return Err(ApiError::Conflict(
            "this target uses CDP as its primary provider and has no extension lease to release"
                .into(),
        ));
    }
    release_from_cdp(&state, &target).await?;
    Ok(axum::Json(
        json!({ "targetId": target, "provider": "extension", "leased": false }),
    ))
}

async fn targets(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let forced = parse_provider(&params)?;
    let extension_connected = state.extension.connected().await;
    let cdp_connected = state.cdp.connected().await;
    if forced == Some(Provider::Extension) && !extension_connected {
        return Err(ApiError::Unavailable(
            "extension provider is not connected".into(),
        ));
    }
    if forced == Some(Provider::Cdp) && !cdp_connected {
        return Err(ApiError::Unavailable(
            "CDP provider is not connected".into(),
        ));
    }
    if forced.is_none() && !extension_connected && !cdp_connected {
        return Err(ApiError::Unavailable(
            "no browser provider is connected".into(),
        ));
    }

    let mut items = Vec::new();
    let mut extension_cdp_targets = std::collections::HashSet::new();
    if extension_connected && forced != Some(Provider::Cdp) {
        let extension_values = state
            .extension
            .call("list", json!({ "scope": params.scope }), DEFAULT_TIMEOUT)
            .await
            .map_err(ApiError::internal)?;
        for item in extension_values.as_array().cloned().unwrap_or_default() {
            if let Some(target) = item.get("cdpTargetId").and_then(Value::as_str) {
                extension_cdp_targets.insert(target.to_owned());
            }
            items.push(item);
        }
    }
    if cdp_connected
        && forced != Some(Provider::Extension)
        && (params.scope.is_none() || forced == Some(Provider::Cdp))
    {
        for target in state.cdp.targets().await.map_err(ApiError::internal)? {
            let target_id = target
                .get("targetId")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if target.get("type").and_then(Value::as_str) != Some("page")
                || extension_cdp_targets.contains(target_id)
            {
                continue;
            }
            items.push(json!({
                "targetId": target_id,
                "url": target.get("url"),
                "title": target.get("title"),
                "type": target.get("type"),
                "provider": "cdp"
            }));
        }
    }
    let mut values = Value::Array(items);
    if params.managed == Some(1) || params.session.is_some() {
        let managed = state.managed.read().await;
        if let Some(items) = values.as_array_mut() {
            items.retain(|item| {
                let id = item
                    .get("targetId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                managed.get(id).is_some_and(|entry| {
                    params
                        .session
                        .as_deref()
                        .is_none_or(|session| entry.session == session)
                }) || item
                    .get("managed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
                    && params.session.as_deref().is_none_or(|session| {
                        item.get("session").and_then(Value::as_str) == Some(session)
                    })
            });
        }
    }
    Ok(axum::Json(values))
}

async fn sessions(State(state): State<Arc<AppState>>) -> ApiResult<impl IntoResponse> {
    let mut grouped: HashMap<String, Vec<ManagedTarget>> = HashMap::new();
    for target in state.managed.read().await.values().cloned() {
        grouped
            .entry(target.session.clone())
            .or_default()
            .push(target);
    }
    if state.extension.connected().await
        && let Ok(values) = state
            .extension
            .call("sessions", json!({}), DEFAULT_TIMEOUT)
            .await
    {
        return Ok(axum::Json(
            json!({ "runtime": grouped, "extension": values }),
        ));
    }
    Ok(axum::Json(json!({ "runtime": grouped })))
}

async fn new_target(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let session = params.session.clone().unwrap_or_else(|| "default".into());
    let url = body_text(&body)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "about:blank".into());
    let _guard = state.queue.acquire([format!("session:{session}")]).await;
    let provider = choose_for(&state, &params, false).await?;
    let result = match provider {
        Provider::Extension => state.extension.call("new", json!({ "url": url, "session": session, "noFocus": params.no_focus.unwrap_or(true) }), DEFAULT_TIMEOUT).await.map_err(ApiError::internal)?,
        Provider::Cdp => {
            let target = state.cdp.create_target(&url).await.map_err(ApiError::internal)?;
            json!({ "targetId": target, "session": session, "ownership": "created", "provider": "cdp", "cdpTargetId": target })
        }
    };
    register_result(&state, &result, provider, &session, "created").await?;
    Ok(axum::Json(result))
}

async fn borrow_target(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let session = params.session.clone().unwrap_or_else(|| "default".into());
    let _guard = state
        .queue
        .acquire([format!("session:{session}"), format!("target:{target}")])
        .await;
    let provider = state
        .choose_provider(parse_provider(&params)?, false)
        .await
        .map_err(ApiError::Unavailable)?;
    let result = match provider {
        Provider::Extension => state
            .extension
            .call(
                "borrow",
                json!({ "target": target, "session": session }),
                Duration::from_secs(90),
            )
            .await
            .map_err(ApiError::internal)?,
        Provider::Cdp => {
            let exists = state
                .cdp
                .targets()
                .await
                .map_err(ApiError::internal)?
                .iter()
                .any(|candidate| {
                    candidate.get("targetId").and_then(Value::as_str) == Some(&target)
                        && candidate.get("type").and_then(Value::as_str) == Some("page")
                });
            if !exists {
                return Err(ApiError::BadRequest(format!(
                    "CDP page target {target} was not found"
                )));
            }
            json!({ "targetId": target, "cdpTargetId": target, "session": session, "ownership": "borrowed", "provider": "cdp", "consent": "caller-authorized" })
        }
    };
    register_result(&state, &result, provider, &session, "borrowed").await?;
    Ok(axum::Json(result))
}

async fn return_target(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let managed = state
        .target(&target)
        .await
        .ok_or_else(|| ApiError::Conflict(format!("target {target} is not managed")))?;
    let _guard = state
        .queue
        .acquire([
            format!("session:{}", managed.session),
            format!("target:{target}"),
        ])
        .await;
    if managed.cdp_leased {
        release_from_cdp(&state, &target).await?;
    }
    let result = match managed.primary_provider {
        Provider::Extension => state
            .extension
            .call(
                "return",
                json!({ "target": target, "session": managed.session }),
                DEFAULT_TIMEOUT,
            )
            .await
            .map_err(ApiError::internal)?,
        Provider::Cdp => {
            json!({ "targetId": target, "ownership": "borrowed", "action": "returned", "provider": "cdp" })
        }
    };
    state.remove_target(&target).await;
    Ok(axum::Json(result))
}

async fn close_target(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    if params.target.is_none() {
        let session = params
            .session
            .clone()
            .ok_or_else(|| ApiError::BadRequest("need target or session".into()))?;
        let _guard = state.queue.acquire([format!("session:{session}")]).await;
        let entries = state
            .managed
            .read()
            .await
            .values()
            .filter(|target| target.session == session)
            .cloned()
            .collect::<Vec<_>>();
        let mut results = Vec::new();
        for entry in &entries {
            if entry.cdp_leased {
                release_from_cdp(&state, &entry.target_id).await?;
            }
        }
        if state.extension.connected().await
            && let Ok(value) = state
                .extension
                .call(
                    "closeSession",
                    json!({ "session": session }),
                    DEFAULT_TIMEOUT,
                )
                .await
        {
            results.push(value);
        }
        for entry in &entries {
            if entry.primary_provider == Provider::Cdp
                && entry.ownership == "created"
                && let Some(cdp_target) = entry.cdp_target_id.as_deref()
            {
                results.push(
                    state
                        .cdp
                        .close_target(cdp_target)
                        .await
                        .map_err(ApiError::internal)?,
                );
            }
        }
        state
            .managed
            .write()
            .await
            .retain(|_, target| target.session != session);
        return Ok(axum::Json(
            json!({ "session": session, "results": results }),
        ));
    }
    let target = require_target(&params)?;
    let managed = state
        .target(&target)
        .await
        .ok_or_else(|| ApiError::Conflict(format!("target {target} is not managed")))?;
    let _guard = state
        .queue
        .acquire([
            format!("session:{}", managed.session),
            format!("target:{target}"),
        ])
        .await;
    if managed.cdp_leased {
        release_from_cdp(&state, &target).await?;
    }
    let result = if managed.ownership == "borrowed" {
        match managed.primary_provider {
            Provider::Extension => state
                .extension
                .call("return", json!({ "target": target }), DEFAULT_TIMEOUT)
                .await
                .map_err(ApiError::internal)?,
            Provider::Cdp => {
                json!({ "targetId": target, "action": "returned", "ownership": "borrowed" })
            }
        }
    } else {
        match managed.primary_provider {
            Provider::Extension => state
                .extension
                .call("close", json!({ "target": target }), DEFAULT_TIMEOUT)
                .await
                .map_err(ApiError::internal)?,
            Provider::Cdp => state
                .cdp
                .close_target(managed.cdp_target_id.as_deref().unwrap_or(&target))
                .await
                .map_err(ApiError::internal)?,
        }
    };
    state.remove_target(&target).await;
    Ok(axum::Json(result))
}

macro_rules! target_get_handler {
    ($name:ident, $command:literal, $cdp_method:literal, $params:expr) => {
        async fn $name(State(state): State<Arc<AppState>>, Query(query): Query<Params>) -> ApiResult<impl IntoResponse> {
            let target = require_target(&query)?;
            let _guard = acquire_target_guard(&state, &query).await;
            let provider = choose_for(&state, &query, false).await?;
            let value = match provider {
                Provider::Extension => state.extension.call($command, json!({ "target": target }), DEFAULT_TIMEOUT).await.map_err(ApiError::internal)?,
                Provider::Cdp => {
                    let cdp_target = resolve_cdp_target(&state, &target).await?;
                    state.cdp.target_command(&cdp_target, $cdp_method, $params).await.map_err(ApiError::internal)?
                }
            };
            Ok(axum::Json(value))
        }
    };
}

target_get_handler!(
    reload,
    "reload",
    "Page.reload",
    json!({ "ignoreCache": true })
);

async fn back(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    navigation_history(state, params, "back", "history.back(); true").await
}

async fn forward(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    navigation_history(state, params, "forward", "history.forward(); true").await
}

async fn navigation_history(
    state: Arc<AppState>,
    params: Params,
    extension_command: &str,
    cdp_expression: &str,
) -> ApiResult<axum::Json<Value>> {
    let target = require_target(&params)?;
    let _guard = acquire_target_guard(&state, &params).await;
    let provider = choose_for(&state, &params, false).await?;
    let value = match provider {
        Provider::Extension => state
            .extension
            .call(
                extension_command,
                json!({ "target": target }),
                DEFAULT_TIMEOUT,
            )
            .await
            .map_err(ApiError::internal)?,
        Provider::Cdp => state
            .cdp
            .evaluate(&resolve_cdp_target(&state, &target).await?, cdp_expression)
            .await
            .map_err(ApiError::internal)?,
    };
    Ok(axum::Json(value))
}

async fn navigate(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let url = body_text(&body)
        .filter(|value| !value.is_empty())
        .or(params.url.clone())
        .ok_or_else(|| ApiError::BadRequest("URL body is required".into()))?;
    let _guard = acquire_target_guard(&state, &params).await;
    let provider = choose_for(&state, &params, false).await?;
    let value = match provider {
        Provider::Extension => state
            .extension
            .call(
                "navigate",
                json!({ "target": target, "url": url }),
                DEFAULT_TIMEOUT,
            )
            .await
            .map_err(ApiError::internal)?,
        Provider::Cdp => state
            .cdp
            .target_command(
                &resolve_cdp_target(&state, &target).await?,
                "Page.navigate",
                json!({ "url": url }),
            )
            .await
            .map_err(ApiError::internal)?,
    };
    Ok(axum::Json(value))
}

async fn info(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    eval_operation(
        state,
        params,
        "JSON.stringify({title:document.title,url:location.href,ready:document.readyState})",
        true,
    )
    .await
}

async fn evaluate(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let expression = body_text(&body)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "document.title".into());
    eval_operation(state, params, &expression, false).await
}

async fn snapshot(
    State(state): State<Arc<AppState>>,
    Query(mut params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    params.max_text = Some(0);
    observe_impl(state, params).await
}

async fn observe(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    observe_impl(state, params).await
}

async fn observe_impl(state: Arc<AppState>, params: Params) -> ApiResult<axum::Json<Value>> {
    let expression = format!(
        "{}({})",
        OBSERVE_JS,
        json!({
            "maxItems": params.max_items.unwrap_or(300),
            "maxText": params.max_text.unwrap_or(12000),
            "includeOffscreen": params.include_offscreen.unwrap_or(false)
        })
    );
    let target = require_target(&params)?;
    let _guard = acquire_target_guard(&state, &params).await;
    let provider = choose_for(&state, &params, false).await?;
    let value = match provider {
        Provider::Extension => state
            .extension
            .call(
                "eval",
                json!({ "target": target, "expr": expression }),
                DEFAULT_TIMEOUT,
            )
            .await
            .map_err(ApiError::internal)?
            .get("value")
            .cloned()
            .unwrap_or(Value::Null),
        Provider::Cdp => state
            .cdp
            .evaluate(&resolve_cdp_target(&state, &target).await?, &expression)
            .await
            .map_err(ApiError::internal)?,
    };
    Ok(axum::Json(value))
}

async fn a11y(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let _guard = acquire_target_guard(&state, &params).await;
    let provider = choose_for(&state, &params, false).await?;
    let value = match provider {
        Provider::Extension => state
            .extension
            .call("a11y", json!({ "target": target }), DEFAULT_TIMEOUT)
            .await
            .map_err(ApiError::internal)?,
        Provider::Cdp => state
            .cdp
            .target_command(
                &resolve_cdp_target(&state, &target).await?,
                "Accessibility.getFullAXTree",
                json!({ "depth": 12 }),
            )
            .await
            .map_err(ApiError::internal)?,
    };
    Ok(axum::Json(value))
}

async fn extract(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let name = params
        .adapter
        .clone()
        .ok_or_else(|| ApiError::BadRequest("adapter is required".into()))?;
    let adapter = state
        .knowledge
        .adapter(&name)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let domains = serde_json::to_string(&adapter.domains).map_err(ApiError::internal)?;
    let adapter_id = serde_json::to_string(&adapter.id).map_err(ApiError::internal)?;
    let expression = format!(
        "(() => {{ const adapterId={adapter_id}; const allowed={domains}; const host=location.hostname; if(!allowed.some(d=>d==='*'||host===d||host.endsWith('.'+d))) throw new Error('adapter '+adapterId+' is not allowed on '+host); return ({}); }})()",
        adapter.expression
    );
    let value = eval_operation_value(&state, &params, &expression).await?;
    Ok(axum::Json(
        json!({ "adapter": name, "data": value, "knowledgeDir": state.knowledge.root() }),
    ))
}

async fn click(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    interaction(
        &state,
        &params,
        "click",
        body_text(&body).unwrap_or_default(),
        json!({}),
    )
    .await
    .map(axum::Json)
}

async fn click_at(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    pointer_interaction(&state, &params, body_text(&body).unwrap_or_default(), false)
        .await
        .map(axum::Json)
}

async fn human_click(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    pointer_interaction(&state, &params, body_text(&body).unwrap_or_default(), true)
        .await
        .map(axum::Json)
}

async fn hover(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    interaction(
        &state,
        &params,
        "hover",
        body_text(&body).unwrap_or_default(),
        json!({}),
    )
    .await
    .map(axum::Json)
}

async fn type_text(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let payload: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    interaction_json(&state, &params, "type", payload)
        .await
        .map(axum::Json)
}

async fn fill(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let payload: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    interaction_json(&state, &params, "fill", payload)
        .await
        .map(axum::Json)
}

async fn select(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let payload: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    interaction_json(&state, &params, "select", payload)
        .await
        .map(axum::Json)
}

async fn press(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let payload = serde_json::from_slice::<Value>(&body)
        .unwrap_or_else(|_| json!({ "key": body_text(&body).unwrap_or_default() }));
    interaction_json(&state, &params, "press", payload)
        .await
        .map(axum::Json)
}

async fn scroll(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    interaction_json(
        &state,
        &params,
        "scroll",
        json!({ "direction": params.direction, "y": params.y }),
    )
    .await
    .map(axum::Json)
}

async fn screenshot(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<Response> {
    let target = require_target(&params)?;
    let _guard = acquire_target_guard(&state, &params).await;
    let provider = choose_for(&state, &params, false).await?;
    let format = params.format.as_deref().unwrap_or("png");
    let value = match provider {
        Provider::Extension => state
            .extension
            .call(
                "screenshot",
                json!({ "target": target, "format": format }),
                DEFAULT_TIMEOUT,
            )
            .await
            .map_err(ApiError::internal)?,
        Provider::Cdp => state
            .cdp
            .target_command(
                &resolve_cdp_target(&state, &target).await?,
                "Page.captureScreenshot",
                json!({ "format": format, "captureBeyondViewport": false }),
            )
            .await
            .map_err(ApiError::internal)?,
    };
    let data = value
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::Internal("provider did not return screenshot data".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(ApiError::internal)?;
    if let Some(path) = params.file {
        tokio::fs::write(&path, bytes)
            .await
            .map_err(ApiError::internal)?;
        return Ok(axum::Json(json!({ "saved": path })).into_response());
    }
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        CONTENT_TYPE,
        HeaderValue::from_str(&format!("image/{format}")).map_err(ApiError::internal)?,
    );
    Ok(response)
}

async fn set_files(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let payload: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let selector = payload
        .get("selector")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("selector is required".into()))?;
    let files = payload
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .ok_or_else(|| ApiError::BadRequest("files is required".into()))?;
    let _guard = acquire_target_guard(&state, &params).await;
    state
        .choose_provider(parse_provider(&params)?, true)
        .await
        .map_err(ApiError::Unavailable)?;
    let cdp_target = lease_to_cdp(&state, &target).await?;
    let operation = async {
        let expression = element_resolver(selector);
        let evaluated = state
            .cdp
            .target_command(
                &cdp_target,
                "Runtime.evaluate",
                json!({ "expression": expression }),
            )
            .await
            .map_err(ApiError::internal)?;
        let object_id = evaluated
            .pointer("/result/objectId")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::BadRequest("element was not found".into()))?;
        state
            .cdp
            .target_command(
                &cdp_target,
                "DOM.setFileInputFiles",
                json!({ "objectId": object_id, "files": files }),
            )
            .await
            .map_err(ApiError::internal)
    }
    .await;
    let release = release_from_cdp(&state, &target).await;
    let value = operation?;
    release?;
    Ok(axum::Json(value))
}

async fn wait_for_navigation(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let timeout = Duration::from_millis(params.timeout.unwrap_or(15000));
    let _guard = acquire_target_guard(&state, &params).await;
    let provider = choose_for(&state, &params, false).await?;
    let cdp_target = if provider == Provider::Cdp {
        Some(resolve_cdp_target(&state, &target).await?)
    } else {
        None
    };
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        let value = match provider {
            Provider::Extension => state.extension.call("eval", json!({ "target": target, "expr": "({url:location.href,ready:document.readyState})" }), DEFAULT_TIMEOUT).await.map_err(ApiError::internal)?.get("value").cloned().unwrap_or(Value::Null),
            Provider::Cdp => state.cdp.evaluate(cdp_target.as_deref().expect("CDP target resolved"), "({url:location.href,ready:document.readyState})").await.map_err(ApiError::internal)?,
        };
        if value.get("ready").and_then(Value::as_str) == Some("complete") {
            return Ok(axum::Json(value));
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(ApiError::Unavailable("navigation wait timed out".into()));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

async fn console_entries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    extension_only(&state, &params, "console", json!({}))
        .await
        .map(axum::Json)
}

async fn network_entries(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    extension_only(&state, &params, "network", json!({}))
        .await
        .map(axum::Json)
}

async fn emulate(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let payload: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    extension_only(&state, &params, "emulate", payload)
        .await
        .map(axum::Json)
}

async fn request_help(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let payload: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    extension_only_timeout(
        &state,
        &params,
        "requestHelp",
        payload,
        Duration::from_secs(600),
    )
    .await
    .map(axum::Json)
}

async fn net_rules(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    axum::Json(json!({ "rules": state.cdp.rules().await }))
}
async fn net_clear(State(state): State<Arc<AppState>>) -> ApiResult<impl IntoResponse> {
    let leased = state
        .managed
        .read()
        .await
        .values()
        .filter(|target| target.cdp_leased)
        .cloned()
        .collect::<Vec<_>>();
    let keys = leased
        .iter()
        .flat_map(|target| {
            [
                format!("session:{}", target.session),
                format!("target:{}", target.target_id),
            ]
        })
        .collect::<Vec<_>>();
    let _guard = state.queue.acquire(keys).await;
    state.cdp.clear_rules().await.map_err(ApiError::internal)?;
    for target in leased {
        release_from_cdp(&state, &target.target_id).await?;
    }
    Ok(axum::Json(json!({ "cleared": true })))
}
async fn net_block(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let pattern = body_text(&body)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::BadRequest("pattern is required".into()))?;
    let _guard = acquire_target_guard(&state, &params).await;
    let cdp_target = lease_to_cdp(&state, &target).await?;
    state
        .cdp
        .add_rule(NetworkRule::Block {
            target_id: cdp_target,
            pattern,
        })
        .await
        .map_err(ApiError::internal)?;
    Ok(axum::Json(
        json!({ "ok": true, "leasedTarget": params.target }),
    ))
}
async fn net_mock(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let value: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let pattern = value
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("pattern is required".into()))?
        .to_owned();
    let _guard = acquire_target_guard(&state, &params).await;
    let cdp_target = lease_to_cdp(&state, &target).await?;
    state
        .cdp
        .add_rule(NetworkRule::Mock {
            target_id: cdp_target,
            pattern,
            status: value.get("status").and_then(Value::as_u64).unwrap_or(200) as u16,
            content_type: value
                .get("contentType")
                .and_then(Value::as_str)
                .unwrap_or("application/json; charset=utf-8")
                .to_owned(),
            body: value
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
        })
        .await
        .map_err(ApiError::internal)?;
    Ok(axum::Json(
        json!({ "ok": true, "leasedTarget": params.target }),
    ))
}
async fn net_rewrite(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let target = require_target(&params)?;
    let value: Value =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let pattern = value
        .get("pattern")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("pattern is required".into()))?
        .to_owned();
    let redirect_url = value
        .get("redirectUrl")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::BadRequest("redirectUrl is required".into()))?
        .to_owned();
    let _guard = acquire_target_guard(&state, &params).await;
    let cdp_target = lease_to_cdp(&state, &target).await?;
    state
        .cdp
        .add_rule(NetworkRule::Rewrite {
            target_id: cdp_target,
            pattern,
            redirect_url,
        })
        .await
        .map_err(ApiError::internal)?;
    Ok(axum::Json(
        json!({ "ok": true, "leasedTarget": params.target }),
    ))
}

async fn knowledge_list(State(state): State<Arc<AppState>>) -> ApiResult<impl IntoResponse> {
    Ok(axum::Json(json!(
        state.knowledge.list().map_err(ApiError::internal)?
    )))
}
async fn knowledge_context(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
) -> ApiResult<impl IntoResponse> {
    let url = params
        .url
        .ok_or_else(|| ApiError::BadRequest("url is required".into()))?;
    Ok(axum::Json(state.knowledge.context_for_url(&url).map_err(
        |error| ApiError::BadRequest(error.to_string()),
    )?))
}
async fn knowledge_put_adapter(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let adapter: AdapterRecord =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let path = state
        .knowledge
        .put_adapter(adapter)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    Ok(axum::Json(json!({ "saved": path })))
}
async fn knowledge_put_pattern(
    State(state): State<Arc<AppState>>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let pattern: PatternWrite =
        serde_json::from_slice(&body).map_err(|error| ApiError::BadRequest(error.to_string()))?;
    let path = state
        .knowledge
        .put_pattern(pattern)
        .map_err(|error| ApiError::BadRequest(error.to_string()))?;
    Ok(axum::Json(json!({ "saved": path })))
}

async fn knowledge_scaffold(
    State(state): State<Arc<AppState>>,
    Query(params): Query<Params>,
    body: Bytes,
) -> ApiResult<impl IntoResponse> {
    let request: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let target = require_target(&params)?;
    let observation = eval_operation_value(
        &state,
        &params,
        &format!(
            "{}({})",
            OBSERVE_JS,
            json!({ "maxItems": 120, "maxText": 4000 })
        ),
    )
    .await?;
    let url = observation
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let host = reqwest::Url::parse(url)
        .ok()
        .and_then(|value| value.host_str().map(ToOwned::to_owned))
        .unwrap_or_else(|| "site".into());
    let id = request.get("id").and_then(Value::as_str).unwrap_or(&host);
    let kind = request
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("adapter");
    let scaffold = if kind == "pattern" {
        json!({
            "domain": id,
            "content": format!("# {id}\n\n## Confirmed page structure\n\n- TODO: record only repeatable, live-verified navigation and failure patterns.\n\n## Evidence\n\n- URL: {url}\n"),
            "sourceUrl": url,
            "observation": observation
        })
    } else {
        json!({
            "schemaVersion": 1,
            "id": id,
            "domains": [host],
            "aliases": [],
            "description": "TODO: describe the verified structured output",
            "expression": "(() => ({ url: location.href, title: document.title }))()",
            "sourceUrl": url,
            "observation": observation,
            "writeEndpoint": "/knowledge/adapters"
        })
    };
    Ok(axum::Json(
        json!({ "target": target, "kind": kind, "scaffold": scaffold, "note": "The Agent must refine and live-verify this draft before writing it to the knowledge store." }),
    ))
}

async fn eval_operation(
    state: Arc<AppState>,
    params: Params,
    expression: &str,
    parse_json: bool,
) -> ApiResult<axum::Json<Value>> {
    let value = eval_operation_value(&state, &params, expression).await?;
    let value = if parse_json {
        value
            .as_str()
            .and_then(|value| serde_json::from_str(value).ok())
            .unwrap_or(value)
    } else {
        json!({ "value": value })
    };
    Ok(axum::Json(value))
}

async fn eval_operation_value(
    state: &Arc<AppState>,
    params: &Params,
    expression: &str,
) -> ApiResult<Value> {
    let target = require_target(params)?;
    let _guard = acquire_target_guard(state, params).await;
    let provider = choose_for(state, params, false).await?;
    match provider {
        Provider::Extension => Ok(state
            .extension
            .call(
                "eval",
                json!({ "target": target, "expr": expression }),
                DEFAULT_TIMEOUT,
            )
            .await
            .map_err(ApiError::internal)?
            .get("value")
            .cloned()
            .unwrap_or(Value::Null)),
        Provider::Cdp => state
            .cdp
            .evaluate(&resolve_cdp_target(state, &target).await?, expression)
            .await
            .map_err(ApiError::internal),
    }
}

async fn interaction(
    state: &Arc<AppState>,
    params: &Params,
    command: &str,
    selector: String,
    extra: Value,
) -> ApiResult<Value> {
    let mut payload = extra;
    payload["selector"] = Value::String(selector);
    interaction_json(state, params, command, payload).await
}

async fn interaction_json(
    state: &Arc<AppState>,
    params: &Params,
    command: &str,
    mut payload: Value,
) -> ApiResult<Value> {
    let target = require_target(params)?;
    let _guard = acquire_target_guard(state, params).await;
    let provider = choose_for(state, params, false).await?;
    payload["target"] = Value::String(target.clone());
    match provider {
        Provider::Extension => state
            .extension
            .call(command, payload, DEFAULT_TIMEOUT)
            .await
            .map_err(ApiError::internal),
        Provider::Cdp => {
            cdp_interaction(
                state,
                &resolve_cdp_target(state, &target).await?,
                command,
                payload,
            )
            .await
        }
    }
}

async fn pointer_interaction(
    state: &Arc<AppState>,
    params: &Params,
    selector: String,
    human: bool,
) -> ApiResult<Value> {
    let target = require_target(params)?;
    let _guard = acquire_target_guard(state, params).await;
    let provider = choose_for(state, params, false).await?;
    if provider == Provider::Extension {
        return state
            .extension
            .call(
                if human { "humanClick" } else { "clickAt" },
                json!({ "target": target, "selector": selector }),
                DEFAULT_TIMEOUT,
            )
            .await
            .map_err(ApiError::internal);
    }
    let cdp_target = resolve_cdp_target(state, &target).await?;
    let center = state.cdp.evaluate(&cdp_target, &format!("(() => {{ const el={}; if(!el) return null; el.scrollIntoView({{block:'center',inline:'center'}}); const r=el.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()", element_resolver(&selector))).await.map_err(ApiError::internal)?;
    let x = center
        .get("x")
        .and_then(Value::as_f64)
        .ok_or_else(|| ApiError::BadRequest("element was not found".into()))?;
    let y = center
        .get("y")
        .and_then(Value::as_f64)
        .ok_or_else(|| ApiError::BadRequest("element was not found".into()))?;
    if human {
        for step in 1..=18 {
            let t = step as f64 / 18.0;
            state
                .cdp
                .target_command(
                    &cdp_target,
                    "Input.dispatchMouseEvent",
                    json!({ "type": "mouseMoved", "x": x*t, "y": y*t, "button": "none" }),
                )
                .await
                .map_err(ApiError::internal)?;
            tokio::time::sleep(Duration::from_millis(12)).await;
        }
    }
    state
        .cdp
        .target_command(
            &cdp_target,
            "Input.dispatchMouseEvent",
            json!({ "type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1 }),
        )
        .await
        .map_err(ApiError::internal)?;
    tokio::time::sleep(Duration::from_millis(if human { 70 } else { 20 })).await;
    state
        .cdp
        .target_command(
            &cdp_target,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1 }),
        )
        .await
        .map_err(ApiError::internal)?;
    Ok(json!({ "clicked": true, "humanized": human, "x": x, "y": y }))
}

async fn cdp_interaction(
    state: &Arc<AppState>,
    target: &str,
    command: &str,
    payload: Value,
) -> ApiResult<Value> {
    let selector = payload
        .get("selector")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let expression = match command {
        "click" => format!(
            "(() => {{ const el={}; if(!el) return {{error:'not found'}}; el.scrollIntoView({{block:'center'}}); el.click(); return {{clicked:true}}; }})()",
            element_resolver(selector)
        ),
        "hover" => return pointer_move(state, target, selector).await,
        "fill" | "type" => {
            let text = payload
                .get("value")
                .or_else(|| payload.get("text"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let encoded = serde_json::to_string(text).map_err(ApiError::internal)?;
            format!(
                "(() => {{ const el={}; if(!el) return {{error:'not found'}}; el.focus(); const p=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; const s=Object.getOwnPropertyDescriptor(p,'value')?.set; if(s)s.call(el,{}); else el.value={}; el.dispatchEvent(new Event('input',{{bubbles:true}})); el.dispatchEvent(new Event('change',{{bubbles:true}})); return {{filled:true}}; }})()",
                element_resolver(selector),
                encoded,
                encoded
            )
        }
        "select" => {
            let values = payload
                .get("values")
                .or_else(|| payload.get("value"))
                .cloned()
                .unwrap_or(Value::Null);
            format!(
                "(() => {{ const el={}; if(!el) return {{error:'not found'}}; const values=new Set([{}].flat().map(String)); for(const o of el.options)o.selected=values.has(o.value)||values.has(o.text); el.dispatchEvent(new Event('change',{{bubbles:true}})); return {{selected:[...el.selectedOptions].map(o=>o.value)}}; }})()",
                element_resolver(selector),
                values
            )
        }
        "scroll" => {
            let direction = payload
                .get("direction")
                .and_then(Value::as_str)
                .unwrap_or("down");
            let y = payload
                .get("y")
                .and_then(Value::as_i64)
                .unwrap_or(3000)
                .abs();
            match direction {
                "top" => "scrollTo(0,0);({ok:true})".into(),
                "bottom" => "scrollTo(0,document.documentElement.scrollHeight);({ok:true})".into(),
                "up" => format!("scrollBy(0,-{y});({{ok:true}})"),
                _ => format!("scrollBy(0,{y});({{ok:true}})"),
            }
        }
        "press" => {
            let key = payload
                .get("key")
                .and_then(Value::as_str)
                .unwrap_or("Enter");
            state
                .cdp
                .target_command(
                    target,
                    "Input.dispatchKeyEvent",
                    json!({ "type": "keyDown", "key": key }),
                )
                .await
                .map_err(ApiError::internal)?;
            return state
                .cdp
                .target_command(
                    target,
                    "Input.dispatchKeyEvent",
                    json!({ "type": "keyUp", "key": key }),
                )
                .await
                .map_err(ApiError::internal);
        }
        _ => {
            return Err(ApiError::BadRequest(format!(
                "unsupported CDP interaction {command}"
            )));
        }
    };
    state
        .cdp
        .evaluate(target, &expression)
        .await
        .map_err(ApiError::internal)
}

async fn pointer_move(state: &Arc<AppState>, target: &str, selector: &str) -> ApiResult<Value> {
    let center = state.cdp.evaluate(target, &format!("(() => {{ const el={}; if(!el)return null; const r=el.getBoundingClientRect(); return {{x:r.x+r.width/2,y:r.y+r.height/2}}; }})()", element_resolver(selector))).await.map_err(ApiError::internal)?;
    let x = center
        .get("x")
        .and_then(Value::as_f64)
        .ok_or_else(|| ApiError::BadRequest("element was not found".into()))?;
    let y = center
        .get("y")
        .and_then(Value::as_f64)
        .ok_or_else(|| ApiError::BadRequest("element was not found".into()))?;
    state
        .cdp
        .target_command(
            target,
            "Input.dispatchMouseEvent",
            json!({ "type": "mouseMoved", "x": x, "y": y, "button": "none" }),
        )
        .await
        .map_err(ApiError::internal)?;
    Ok(json!({ "hovered": true, "x": x, "y": y }))
}

async fn extension_only(
    state: &Arc<AppState>,
    params: &Params,
    command: &str,
    payload: Value,
) -> ApiResult<Value> {
    extension_only_timeout(state, params, command, payload, DEFAULT_TIMEOUT).await
}
async fn extension_only_timeout(
    state: &Arc<AppState>,
    params: &Params,
    command: &str,
    mut payload: Value,
    timeout: Duration,
) -> ApiResult<Value> {
    let target = require_target(params)?;
    let _guard = acquire_target_guard(state, params).await;
    let managed = ensure_managed_target(state, &target).await?;
    if managed.primary_provider != Provider::Extension {
        return Err(ApiError::Conflict(format!(
            "{command} requires a target created or borrowed by the extension provider"
        )));
    }
    if managed.cdp_leased {
        return Err(ApiError::Conflict(format!(
            "target {target} is leased to CDP; release the provider lease first"
        )));
    }
    if !state.extension.connected().await {
        return Err(ApiError::Unavailable(format!(
            "{command} requires the extension provider"
        )));
    }
    payload["target"] = Value::String(target);
    state
        .extension
        .call(command, payload, timeout)
        .await
        .map_err(ApiError::internal)
}

async fn register_result(
    state: &Arc<AppState>,
    result: &Value,
    provider: Provider,
    session: &str,
    ownership: &str,
) -> ApiResult<()> {
    let target_id = result
        .get("targetId")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::Internal("provider did not return targetId".into()))?
        .to_owned();
    state
        .register_target(ManagedTarget {
            target_id,
            session: result
                .get("session")
                .and_then(Value::as_str)
                .unwrap_or(session)
                .to_owned(),
            ownership: result
                .get("ownership")
                .and_then(Value::as_str)
                .unwrap_or(ownership)
                .to_owned(),
            primary_provider: provider,
            cdp_target_id: result
                .get("cdpTargetId")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            tab_id: result
                .get("tabId")
                .and_then(Value::as_u64)
                .map(|value| value as u32),
            cdp_leased: false,
        })
        .await;
    Ok(())
}

async fn resolve_cdp_target(state: &Arc<AppState>, target: &str) -> ApiResult<String> {
    lease_to_cdp(state, target).await
}

async fn choose_for(
    state: &Arc<AppState>,
    params: &Params,
    cdp_required: bool,
) -> ApiResult<Provider> {
    let forced = parse_provider(params)?;
    if let Some(target_id) = params.target.as_deref() {
        let target = ensure_managed_target(state, target_id).await?;
        if target.cdp_leased {
            if forced == Some(Provider::Extension) {
                return Err(ApiError::Conflict(format!(
                    "target {target_id} is leased to CDP; release the provider lease first"
                )));
            }
            if state.cdp.connected().await {
                return Ok(Provider::Cdp);
            }
            return Err(ApiError::Unavailable(
                "target is leased to CDP but the CDP provider disconnected".into(),
            ));
        }
        if target.primary_provider == Provider::Cdp {
            if forced == Some(Provider::Extension) {
                return Err(ApiError::Conflict(format!(
                    "target {target_id} is owned by the CDP provider"
                )));
            }
            return state
                .cdp
                .connected()
                .await
                .then_some(Provider::Cdp)
                .ok_or_else(|| ApiError::Unavailable("CDP provider is not connected".into()));
        }
        if forced.is_none() && !cdp_required && state.extension.connected().await {
            return Ok(Provider::Extension);
        }
    }
    state
        .choose_provider(forced, cdp_required)
        .await
        .map_err(ApiError::Unavailable)
}

async fn lease_to_cdp(state: &Arc<AppState>, target_id: &str) -> ApiResult<String> {
    if !state.cdp.connected().await {
        return Err(ApiError::Unavailable(
            "CDP provider is not connected".into(),
        ));
    }
    let mut target = ensure_managed_target(state, target_id).await?;
    if target.primary_provider == Provider::Cdp {
        return Ok(target.cdp_target_id.unwrap_or_else(|| target_id.to_owned()));
    }
    if target.cdp_leased {
        return target
            .cdp_target_id
            .ok_or_else(|| ApiError::Internal("leased target has no CDP target id".into()));
    }
    let value = state
        .extension
        .call("leaseCdp", json!({ "target": target_id }), DEFAULT_TIMEOUT)
        .await
        .map_err(ApiError::internal)?;
    let cdp_target = value
        .get("cdpTargetId")
        .and_then(Value::as_str)
        .or(target.cdp_target_id.as_deref())
        .ok_or_else(|| ApiError::Internal("extension could not resolve a CDP target id".into()))?
        .to_owned();
    if let Err(error) = state.cdp.session_for(&cdp_target).await {
        state
            .extension
            .call("resumeCdp", json!({ "target": target_id }), DEFAULT_TIMEOUT)
            .await
            .ok();
        return Err(ApiError::internal(error));
    }
    target.cdp_target_id = Some(cdp_target.clone());
    target.cdp_leased = true;
    state.register_target(target).await;
    Ok(cdp_target)
}

async fn release_from_cdp(state: &Arc<AppState>, target_id: &str) -> ApiResult<()> {
    let mut target = ensure_managed_target(state, target_id).await?;
    if target.primary_provider == Provider::Cdp || !target.cdp_leased {
        return Ok(());
    }
    if let Some(cdp_target) = target.cdp_target_id.as_deref() {
        state
            .cdp
            .detach_target(cdp_target)
            .await
            .map_err(ApiError::internal)?;
    }
    state
        .extension
        .call("resumeCdp", json!({ "target": target_id }), DEFAULT_TIMEOUT)
        .await
        .map_err(ApiError::internal)?;
    target.cdp_leased = false;
    state.register_target(target).await;
    Ok(())
}

async fn ensure_managed_target(state: &Arc<AppState>, target_id: &str) -> ApiResult<ManagedTarget> {
    state.target(target_id).await.ok_or_else(|| {
        ApiError::Conflict(format!(
            "target {target_id} is not managed; create or borrow it first"
        ))
    })
}

async fn acquire_target_guard(state: &Arc<AppState>, params: &Params) -> crate::state::QueueGuard {
    let keys = state
        .queue_keys(params.target.as_deref(), params.session.as_deref())
        .await;
    state.queue.acquire(keys).await
}

fn parse_provider(params: &Params) -> ApiResult<Option<Provider>> {
    Provider::parse(params.provider.as_deref()).map_err(ApiError::BadRequest)
}
fn require_target(params: &Params) -> ApiResult<String> {
    params
        .target
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::BadRequest("target is required".into()))
}
fn body_text(bytes: &Bytes) -> Option<String> {
    String::from_utf8(bytes.to_vec())
        .ok()
        .map(|value| value.trim().to_owned())
}
fn cdp_required(operation: &str) -> bool {
    matches!(
        operation,
        "setFiles" | "net.block" | "net.mock" | "net.rewrite" | "net.clear"
    )
}

fn element_resolver(selector: &str) -> String {
    let encoded = serde_json::to_string(selector).unwrap_or_else(|_| "\"\"".into());
    format!(
        "(() => {{ const input={encoded}; if(/^@e[1-9]\\d*$/.test(input)) {{ const v2=window[Symbol.for('cyh-browser-skill.refs.v2')]; const v1=window[Symbol.for('cyh-browser-skill.refs.v1')]; return v2?.refs?.get(input)||v1?.refs?.get(input)||null; }} try {{ return document.querySelector(input); }} catch {{ return null; }} }})()"
    )
}
