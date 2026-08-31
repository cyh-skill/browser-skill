use std::{collections::HashMap, path::PathBuf, sync::Arc};

use anyhow::Result;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};

use crate::{cdp::CdpHub, extension::ExtensionHub, knowledge::KnowledgeStore};

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub http_port: u16,
    pub extension_port: u16,
    pub browser: Option<String>,
    pub cdp_endpoint: Option<String>,
    pub knowledge_dir: PathBuf,
}

impl RuntimeConfig {
    pub fn from_args(
        http_port: u16,
        extension_port: u16,
        browser: Option<String>,
        cdp_endpoint: Option<String>,
        knowledge_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            http_port,
            extension_port,
            browser,
            cdp_endpoint,
            knowledge_dir: knowledge_dir.unwrap_or_else(default_knowledge_dir),
        }
    }
}

pub fn default_knowledge_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".browser-skill")
        .join("knowledge")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Extension,
    Cdp,
}

impl Provider {
    pub fn parse(value: Option<&str>) -> Result<Option<Self>, String> {
        match value.filter(|value| !value.is_empty() && *value != "auto") {
            None => Ok(None),
            Some("ext" | "extension") => Ok(Some(Self::Extension)),
            Some("cdp") => Ok(Some(Self::Cdp)),
            Some(other) => Err(format!(
                "unknown provider {other}; use auto, extension, or cdp"
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedTarget {
    pub target_id: String,
    pub session: String,
    pub ownership: String,
    pub primary_provider: Provider,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cdp_target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<u32>,
    #[serde(default)]
    pub cdp_leased: bool,
}

#[derive(Default)]
pub struct OperationQueue {
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl OperationQueue {
    pub async fn acquire(&self, keys: impl IntoIterator<Item = String>) -> QueueGuard {
        let mut keys = keys
            .into_iter()
            .filter(|key| !key.is_empty())
            .collect::<Vec<_>>();
        keys.sort();
        keys.dedup();

        let locks = {
            let mut registry = self.locks.lock().await;
            keys.iter()
                .map(|key| {
                    registry
                        .entry(key.clone())
                        .or_insert_with(|| Arc::new(Mutex::new(())))
                        .clone()
                })
                .collect::<Vec<_>>()
        };
        let mut guards = Vec::with_capacity(locks.len());
        for lock in locks {
            guards.push(lock.lock_owned().await);
        }
        QueueGuard { _guards: guards }
    }

    pub async fn size(&self) -> usize {
        self.locks.lock().await.len()
    }
}

pub struct QueueGuard {
    _guards: Vec<OwnedMutexGuard<()>>,
}

pub struct AppState {
    pub config: RuntimeConfig,
    pub extension: ExtensionHub,
    pub cdp: CdpHub,
    pub knowledge: KnowledgeStore,
    pub managed: RwLock<HashMap<String, ManagedTarget>>,
    pub queue: OperationQueue,
}

impl AppState {
    pub async fn new(config: RuntimeConfig) -> Result<Self> {
        let knowledge = KnowledgeStore::new(config.knowledge_dir.clone());
        knowledge.init()?;
        Ok(Self {
            config,
            extension: ExtensionHub::default(),
            cdp: CdpHub::default(),
            knowledge,
            managed: RwLock::new(HashMap::new()),
            queue: OperationQueue::default(),
        })
    }

    pub async fn register_target(&self, target: ManagedTarget) {
        self.managed
            .write()
            .await
            .insert(target.target_id.clone(), target);
    }

    pub async fn remove_target(&self, target_id: &str) -> Option<ManagedTarget> {
        self.managed.write().await.remove(target_id)
    }

    pub async fn target(&self, target_id: &str) -> Option<ManagedTarget> {
        self.managed.read().await.get(target_id).cloned()
    }

    pub async fn queue_keys(&self, target: Option<&str>, session: Option<&str>) -> Vec<String> {
        let mut keys = Vec::new();
        if let Some(target) = target.filter(|value| !value.is_empty()) {
            keys.push(format!("target:{target}"));
            if session.is_none()
                && let Some(managed) = self.target(target).await
            {
                keys.push(format!("session:{}", managed.session));
            }
        }
        if let Some(session) = session.filter(|value| !value.is_empty()) {
            keys.push(format!("session:{session}"));
        }
        keys
    }

    pub async fn choose_provider(
        &self,
        forced: Option<Provider>,
        cdp_required: bool,
    ) -> Result<Provider, String> {
        if let Some(forced) = forced {
            return match forced {
                Provider::Extension if self.extension.connected().await => Ok(forced),
                Provider::Cdp if self.cdp.connected().await => Ok(forced),
                Provider::Extension => Err("extension provider is not connected".into()),
                Provider::Cdp => Err("CDP provider is not connected".into()),
            };
        }
        if cdp_required {
            return self.cdp.connected().await.then_some(Provider::Cdp)
                .ok_or_else(|| "this operation requires CDP; enable remote debugging or configure BROWSER_SKILL_CDP_ENDPOINT".into());
        }
        if self.extension.connected().await {
            Ok(Provider::Extension)
        } else if self.cdp.connected().await {
            Ok(Provider::Cdp)
        } else {
            Err("no browser provider is connected".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    #[tokio::test]
    async fn multi_key_queue_serializes_session_and_target() {
        let queue = Arc::new(OperationQueue::default());
        let first = queue.acquire(["session:a".into(), "target:1".into()]).await;
        let queued = Arc::new(AtomicU64::new(0));
        let marker = queued.clone();
        let q = queue.clone();
        let task = tokio::spawn(async move {
            let _guard = q.acquire(["session:a".into()]).await;
            marker.store(1, std::sync::atomic::Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        assert_eq!(queued.load(std::sync::atomic::Ordering::SeqCst), 0);
        drop(first);
        task.await.unwrap();
        assert_eq!(queued.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
