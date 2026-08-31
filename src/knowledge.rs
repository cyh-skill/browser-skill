use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct KnowledgeStore {
    root: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterRecord {
    pub id: String,
    #[serde(default)]
    pub domains: Vec<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
    pub description: String,
    pub expression: String,
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatternWrite {
    pub domain: String,
    pub content: String,
    #[serde(default)]
    pub source_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeList {
    pub root: PathBuf,
    pub adapters: Vec<AdapterSummary>,
    pub patterns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterSummary {
    pub id: String,
    pub domains: Vec<String>,
    pub aliases: Vec<String>,
    pub description: String,
    pub verified_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationReport {
    pub root: PathBuf,
    pub valid: bool,
    pub adapter_count: usize,
    pub pattern_count: usize,
    pub errors: Vec<String>,
}

fn schema_version() -> u32 {
    1
}

impl KnowledgeStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn init(&self) -> Result<()> {
        fs::create_dir_all(self.adapters_dir())?;
        fs::create_dir_all(self.patterns_dir())?;
        let manifest = self.root.join("manifest.json");
        if !manifest.exists() {
            atomic_write(&manifest, br#"{
  "schemaVersion": 1,
  "kind": "cyh-browser-skill-knowledge",
  "description": "External site patterns and page adapters. This directory may be a standalone Git repository."
}
"#)?;
        }
        Ok(())
    }

    pub fn list(&self) -> Result<KnowledgeList> {
        self.init()?;
        let mut adapters = Vec::new();
        for path in sorted_files(&self.adapters_dir(), "json")? {
            let adapter = self.load_adapter_path(&path)?;
            adapters.push(AdapterSummary {
                id: adapter.id,
                domains: adapter.domains,
                aliases: adapter.aliases,
                description: adapter.description,
                verified_at: adapter.verified_at,
            });
        }
        let patterns = sorted_files(&self.patterns_dir(), "md")?
            .into_iter()
            .filter_map(|path| {
                path.file_stem()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .collect();
        Ok(KnowledgeList {
            root: self.root.clone(),
            adapters,
            patterns,
        })
    }

    pub fn validate(&self) -> Result<ValidationReport> {
        self.init()?;
        let mut errors = Vec::new();
        let mut adapter_count = 0;
        let mut identifiers = HashMap::<String, String>::new();
        for path in sorted_files(&self.adapters_dir(), "json")? {
            match self.load_adapter_path(&path).and_then(validate_adapter) {
                Ok(adapter) => {
                    adapter_count += 1;
                    for identifier in std::iter::once(&adapter.id).chain(adapter.aliases.iter()) {
                        let normalized = identifier.trim().to_lowercase();
                        if let Some(existing) = identifiers.insert(normalized, adapter.id.clone())
                            && existing != adapter.id
                        {
                            errors.push(format!(
                                "{}: identifier {:?} is already owned by adapter {:?}",
                                path.display(),
                                identifier,
                                existing
                            ));
                        }
                    }
                }
                Err(error) => errors.push(format!("{}: {error}", path.display())),
            }
        }
        let pattern_files = sorted_files(&self.patterns_dir(), "md")?;
        for path in &pattern_files {
            match fs::read_to_string(path) {
                Ok(content) if content.trim().len() >= 20 => {}
                Ok(_) => errors.push(format!("{}: pattern is empty or too short", path.display())),
                Err(error) => errors.push(format!("{}: {error}", path.display())),
            }
        }
        Ok(ValidationReport {
            root: self.root.clone(),
            valid: errors.is_empty(),
            adapter_count,
            pattern_count: pattern_files.len(),
            errors,
        })
    }

    pub fn adapter(&self, id: &str) -> Result<AdapterRecord> {
        let id = id.trim();
        if id.is_empty() {
            bail!("adapter id or alias is required");
        }
        if let Ok(file_id) = safe_name(id) {
            let direct = self.adapters_dir().join(format!("{file_id}.json"));
            if direct.exists() {
                return self.load_adapter_path(&direct);
            }
        }
        for path in sorted_files(&self.adapters_dir(), "json")? {
            let adapter = self.load_adapter_path(&path)?;
            if adapter.id.eq_ignore_ascii_case(id)
                || adapter
                    .aliases
                    .iter()
                    .any(|alias| alias.eq_ignore_ascii_case(id))
            {
                return Ok(adapter);
            }
        }
        bail!("adapter {id:?} was not found")
    }

    pub fn put_adapter(&self, mut adapter: AdapterRecord) -> Result<PathBuf> {
        self.init()?;
        adapter.id = safe_name(&adapter.id)?;
        if adapter.schema_version == 0 {
            adapter.schema_version = schema_version();
        }
        validate_adapter(adapter.clone())?;
        let path = self.adapters_dir().join(format!("{}.json", adapter.id));
        atomic_write(&path, &serde_json::to_vec_pretty(&adapter)?)?;
        Ok(path)
    }

    pub fn put_pattern(&self, pattern: PatternWrite) -> Result<PathBuf> {
        self.init()?;
        let domain = safe_name(&pattern.domain)?;
        if pattern.content.trim().len() < 20 {
            bail!("pattern content must contain at least 20 characters");
        }
        let mut content = pattern.content.trim().to_owned();
        if !content.starts_with('#') {
            content = format!("# {domain}\n\n{content}");
        }
        if let Some(source) = pattern.source_url.filter(|value| !value.trim().is_empty()) {
            content.push_str(&format!(
                "\n\n## Evidence\n\n- Source: {source}\n- Captured: {}\n",
                unix_timestamp()
            ));
        } else {
            content.push('\n');
        }
        let path = self.patterns_dir().join(format!("{domain}.md"));
        atomic_write(&path, content.as_bytes())?;
        Ok(path)
    }

    pub fn context_for_url(&self, url: &str) -> Result<serde_json::Value> {
        let parsed = reqwest::Url::parse(url).context("invalid knowledge context URL")?;
        if !matches!(parsed.scheme(), "http" | "https") {
            bail!("knowledge context URL must use http or https");
        }
        let host = parsed
            .host_str()
            .map(ToOwned::to_owned)
            .ok_or_else(|| anyhow!("knowledge context URL has no host"))?;
        let list = self.list()?;
        let adapters = list
            .adapters
            .into_iter()
            .filter(|adapter| {
                adapter
                    .domains
                    .iter()
                    .any(|domain| domain_matches(&host, domain))
            })
            .collect::<Vec<_>>();
        let patterns = list
            .patterns
            .into_iter()
            .filter(|domain| domain_matches(&host, domain))
            .map(|domain| {
                let content = fs::read_to_string(self.patterns_dir().join(format!("{domain}.md")))
                    .unwrap_or_default();
                serde_json::json!({ "domain": domain, "content": content })
            })
            .collect::<Vec<_>>();
        Ok(serde_json::json!({ "host": host, "adapters": adapters, "patterns": patterns }))
    }

    fn adapters_dir(&self) -> PathBuf {
        self.root.join("adapters")
    }
    fn patterns_dir(&self) -> PathBuf {
        self.root.join("patterns")
    }

    fn load_adapter_path(&self, path: &Path) -> Result<AdapterRecord> {
        let bytes =
            fs::read(path).with_context(|| format!("cannot read adapter {}", path.display()))?;
        let adapter: AdapterRecord = serde_json::from_slice(&bytes)
            .with_context(|| format!("invalid adapter JSON {}", path.display()))?;
        let file_id = path
            .file_stem()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if adapter.id != file_id {
            bail!(
                "adapter id {:?} does not match file name {:?}",
                adapter.id,
                file_id
            );
        }
        validate_adapter(adapter)
    }
}

fn validate_adapter(adapter: AdapterRecord) -> Result<AdapterRecord> {
    safe_name(&adapter.id)?;
    if adapter.description.trim().is_empty() {
        bail!("description is required");
    }
    if adapter.domains.is_empty() {
        bail!("at least one domain or * is required");
    }
    if adapter.expression.trim().len() < 20 {
        bail!("expression is empty or too short");
    }
    if adapter.expression.len() > 200_000 {
        bail!("expression exceeds 200000 bytes");
    }
    if adapter.domains.iter().any(|domain| {
        domain != "*" && (safe_name(domain).is_err() || *domain != domain.to_ascii_lowercase())
    }) {
        bail!(
            "domains must be lowercase and may only contain letters, digits, dots, underscores, and hyphens"
        );
    }
    if adapter.aliases.iter().any(|alias| {
        let alias = alias.trim();
        alias.is_empty() || alias.len() > 100 || alias.chars().any(char::is_control)
    }) {
        bail!("aliases must be non-empty, at most 100 bytes, and contain no control characters");
    }
    Ok(adapter)
}

fn safe_name(value: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("name is required");
    }
    let re = Regex::new(r"^[A-Za-z0-9._-]+$").expect("valid regex");
    if !re.is_match(value) || value == "." || value == ".." {
        bail!("invalid name {value:?}");
    }
    Ok(value.to_owned())
}

fn sorted_files(dir: &Path, extension: &str) -> Result<Vec<PathBuf>> {
    let mut files = fs::read_dir(dir)?
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|value| value.to_str()) == Some(extension))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        Uuid::new_v4()
    ));
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn unix_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn domain_matches(host: &str, pattern: &str) -> bool {
    pattern == "*" || host == pattern || host.ends_with(&format!(".{pattern}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knowledge_store_round_trip_and_rejects_traversal() {
        let temp = tempfile::tempdir().unwrap();
        let store = KnowledgeStore::new(temp.path().to_path_buf());
        store.init().unwrap();
        store
            .put_adapter(AdapterRecord {
                id: "example.com".into(),
                domains: vec!["example.com".into()],
                aliases: vec!["示例".into()],
                description: "example adapter".into(),
                expression: "(() => ({ title: document.title }))()".into(),
                schema_version: 1,
                source_url: None,
                verified_at: None,
            })
            .unwrap();
        assert_eq!(
            store.adapter("example.com").unwrap().domains,
            ["example.com"]
        );
        assert_eq!(store.adapter("示例").unwrap().id, "example.com");
        assert!(store.adapter("../secret").is_err());
        assert!(store.context_for_url("not a URL").is_err());
        assert!(
            store
                .put_adapter(AdapterRecord {
                    id: "empty.example".into(),
                    domains: vec![],
                    aliases: vec![],
                    description: "invalid adapter".into(),
                    expression: "(() => ({ ok: true }))()".into(),
                    schema_version: 1,
                    source_url: None,
                    verified_at: None,
                })
                .is_err()
        );
        assert!(store.validate().unwrap().valid);
    }
}
