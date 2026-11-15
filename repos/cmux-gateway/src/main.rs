pub mod cmux;
pub mod git_view;
pub mod loopback;
pub mod pairing_store;
pub mod protocol;
pub mod push;
pub mod scanner;
pub mod server;
pub mod static_files;
pub mod uploads;

mod cli;

use clap::{Args, Parser, Subcommand};
use std::net::SocketAddr;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use crate::loopback::parse_and_validate_bind;
use crate::server::{create_router, AppState};

#[derive(Parser, Debug)]
#[command(
    name = "cmob",
    version,
    about = "Watch and control your cmux terminals and coding agents from a phone",
    after_help = "First time: run `cmob setup` in a cmux terminal, then `cmob qr --tailscale`."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand, Debug)]
enum Command {
    /// One-time setup (run inside cmux): token, autostart, gateway
    Setup,
    /// Start the gateway in the background (inside cmux)
    Start {
        /// Print nothing unless something is wrong (used by the autostart hook)
        #[arg(long, hide = true)]
        quiet: bool,
    },
    /// Stop the gateway
    Stop,
    /// Restart the gateway
    Restart,
    /// Show gateway health, connected clients and paired devices
    Status,
    /// Print a QR code that pairs a phone
    Qr {
        /// Use the HTTPS address from Tailscale (needed for phones)
        #[arg(long)]
        tailscale: bool,
    },
    /// List paired devices, or revoke one
    Devices {
        #[command(subcommand)]
        action: Option<DevicesCommand>,
    },
    /// Show the gateway log
    Logs {
        /// Keep following new lines
        #[arg(short, long)]
        follow: bool,
    },
    /// Remove autostart and stop the gateway
    Uninstall,
    /// Run the gateway in the foreground (what `start` runs in the background)
    Serve(ServeArgs),
}

#[derive(Subcommand, Debug)]
enum DevicesCommand {
    /// Disconnect a device and delete its access (id or the first letters of it)
    Revoke { id: String },
}

#[derive(Args, Debug)]
struct ServeArgs {
    /// Bind host address (strictly loopback or Tailscale interface)
    #[arg(long, default_value = "127.0.0.1", env = "CMUX_GATEWAY_HOST")]
    host: String,

    /// Bind port number
    #[arg(long, default_value_t = 8088, env = "CMUX_GATEWAY_PORT")]
    port: u16,

    /// Bearer authentication token (default: the one in ~/.cmux/gateway-token)
    #[arg(long, env = "CMUX_GATEWAY_TOKEN", hide_env_values = true)]
    token: Option<String>,

    /// Suppress the startup banner
    #[arg(long)]
    quiet: bool,
}

fn main() {
    // Let `cmob status | head` end quietly instead of panicking on a closed pipe.
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let cli = Cli::parse();
    let result = match cli.command {
        Command::Serve(args) => serve(args).map_err(|e| e.to_string()),
        Command::Setup => cli::setup(),
        Command::Start { quiet } => cli::start(quiet),
        Command::Stop => cli::stop(),
        Command::Restart => cli::restart(),
        Command::Status => cli::status(),
        Command::Qr { tailscale } => cli::qr(tailscale),
        Command::Devices { action: None } => cli::devices_list(),
        Command::Devices { action: Some(DevicesCommand::Revoke { id }) } => cli::devices_revoke(&id),
        Command::Logs { follow } => cli::logs(follow),
        Command::Uninstall => cli::uninstall(),
    };
    if let Err(message) = result {
        // `status` reports its own problem and only needs the exit code.
        if !message.is_empty() {
            eprintln!("✗ {message}");
        }
        std::process::exit(1);
    }
}

#[tokio::main]
async fn serve(args: ServeArgs) -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                // Log targets are `cmob::...` in the binary and `cmux_gateway::...` in the library.
                .unwrap_or_else(|_| "cmob=info,cmux_gateway=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    // 1. Validate loopback/Tailscale bind address
    let bind_addr: SocketAddr = parse_and_validate_bind(&args.host, args.port)?;

    // 2. Resolve the authentication token (flag or env, else the token file, created on first use)
    let token = match args.token {
        Some(t) => t,
        None => cli::read_or_create_token()?,
    };

    let app_state = AppState::new(args.host.clone(), args.port, token);

    if !args.quiet {
        println!();
        println!("cmob gateway v{}", env!("CARGO_PKG_VERSION"));
        println!("  Listening on : http://{bind_addr}");
        println!("  Token        : {}", cli::token_path()?.display());
        println!("  Pair a phone : cmob qr --tailscale");
        println!();
    }

    let router = create_router(app_state);
    let listener = tokio::net::TcpListener::bind(bind_addr).await?;
    cli::write_pid();
    info!("Server listening on http://{}", bind_addr);

    axum::serve(listener, router).await?;

    Ok(())
}
