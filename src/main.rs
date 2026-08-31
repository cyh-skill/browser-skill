mod api;
mod cdp;
mod extension;
mod knowledge;
mod state;

use std::{net::SocketAddr, path::PathBuf, sync::Arc};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use state::{AppState, RuntimeConfig};
use tokio::net::TcpListener;
use tracing::{info, warn};
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "browser-skill",
    version,
    about = "cyh-browser-skill Rust runtime"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Start the unified HTTP runtime, extension bridge, and optional CDP sidecar.
    Serve(ServeArgs),
    /// Inspect local configuration and provider availability without changing browser state.
    Doctor(ServeArgs),
    /// Validate or initialize an external browser knowledge store.
    Knowledge {
        #[command(subcommand)]
        command: KnowledgeCommand,
        #[arg(long)]
        dir: Option<PathBuf>,
    },
}

#[derive(Debug, Clone, clap::Args)]
struct ServeArgs {
    #[arg(long, env = "BROWSER_SKILL_HTTP_PORT", default_value_t = 3456)]
    http_port: u16,
    #[arg(long, env = "BROWSER_SKILL_EXTENSION_PORT", default_value_t = 3458)]
    extension_port: u16,
    #[arg(long, env = "BROWSER_SKILL_BROWSER")]
    browser: Option<String>,
    #[arg(long, env = "BROWSER_SKILL_CDP_ENDPOINT")]
    cdp_endpoint: Option<String>,
    #[arg(long, env = "BROWSER_SKILL_KNOWLEDGE_DIR")]
    knowledge_dir: Option<PathBuf>,
}

impl Default for ServeArgs {
    fn default() -> Self {
        Self {
            http_port: 3456,
            extension_port: 3458,
            browser: None,
            cdp_endpoint: None,
            knowledge_dir: None,
        }
    }
}

#[derive(Debug, Subcommand)]
enum KnowledgeCommand {
    Init,
    Validate,
    List,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with_target(false)
        .compact()
        .init();

    load_local_environment();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve(ServeArgs::default())) {
        Command::Serve(args) => serve(args).await,
        Command::Doctor(args) => doctor(args).await,
        Command::Knowledge { command, dir } => knowledge_command(command, dir).await,
    }
}

fn load_local_environment() {
    if let Some(home) = dirs::home_dir() {
        let _ = dotenvy::from_path(home.join(".browser-skill").join("config.env"));
    }
    let _ = dotenvy::dotenv();
}

async fn serve(args: ServeArgs) -> Result<()> {
    let config = RuntimeConfig::from_args(
        args.http_port,
        args.extension_port,
        args.browser,
        args.cdp_endpoint,
        args.knowledge_dir,
    );
    let state = Arc::new(AppState::new(config.clone()).await?);

    let extension_state = state.clone();
    tokio::spawn(async move {
        if let Err(error) = extension::serve(extension_state).await {
            warn!(%error, "extension bridge stopped");
        }
    });

    cdp::spawn_reconnector(state.clone());

    let address = SocketAddr::from(([127, 0, 0, 1], config.http_port));
    let listener = TcpListener::bind(address)
        .await
        .with_context(|| format!("cannot bind HTTP API to {address}"))?;
    info!(%address, knowledge = %config.knowledge_dir.display(), "browser-skill runtime ready");
    axum::serve(listener, api::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP server failed")
}

async fn doctor(args: ServeArgs) -> Result<()> {
    let config = RuntimeConfig::from_args(
        args.http_port,
        args.extension_port,
        args.browser,
        args.cdp_endpoint,
        args.knowledge_dir,
    );
    let report = cdp::doctor(&config).await;
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "runtime": env!("CARGO_PKG_VERSION"),
            "http": format!("127.0.0.1:{}", config.http_port),
            "extension_ws": format!("127.0.0.1:{}", config.extension_port),
            "knowledge": config.knowledge_dir,
            "knowledge_valid": knowledge::KnowledgeStore::new(config.knowledge_dir.clone()).validate().is_ok_and(|report| report.valid),
            "cdp": report,
        }))?
    );
    Ok(())
}

async fn knowledge_command(command: KnowledgeCommand, dir: Option<PathBuf>) -> Result<()> {
    let dir = dir.unwrap_or_else(state::default_knowledge_dir);
    let store = knowledge::KnowledgeStore::new(dir);
    match command {
        KnowledgeCommand::Init => {
            store.init()?;
            println!("{}", store.root().display());
        }
        KnowledgeCommand::Validate => {
            let report = store.validate()?;
            println!("{}", serde_json::to_string_pretty(&report)?);
            if !report.valid {
                anyhow::bail!("knowledge store validation failed");
            }
        }
        KnowledgeCommand::List => {
            println!("{}", serde_json::to_string_pretty(&store.list()?)?);
        }
    }
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };
    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = terminate => {} }
}
