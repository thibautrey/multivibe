use axum::Router;
use multivibe_v1_edge::{EdgeConfig, EdgeState, build_relay_router, build_router};
use tokio::net::TcpListener;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Both ring and aws-lc-rs are present in the dependency tree, so rustls
    // cannot pick a process-level provider on its own.
    let _ = rustls::crypto::ring::default_provider().install_default();
    let config = EdgeConfig::from_env();
    let bind_address = format!("{}:{}", config.listen_host, config.listen_port);
    let state = EdgeState::new(config.clone()).await?;
    let model_catalog_monitor = state.start_model_catalog_monitor();
    let job_runner = state.start_job_runner();
    let shutdown_state = state.clone();
    let router: Router = build_router(state.clone());
    let listener = TcpListener::bind(&bind_address).await?;

    if let (Some(port), Some(cert), Some(key)) = (
        config.backend_relay_port,
        config.backend_relay_cert_path.clone(),
        config.backend_relay_key_path.clone(),
    ) {
        let relay_router = build_relay_router(state.clone());
        tokio::spawn(async move {
            match axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key).await {
                Ok(tls) => {
                    let address = std::net::SocketAddr::from(([0, 0, 0, 0], port));
                    println!(
                        "multivibe backend relay listening on https://0.0.0.0:{} (chatgpt_base_url=/backend-api)",
                        port
                    );
                    if let Err(error) = axum_server::bind_rustls(address, tls)
                        .serve(relay_router.into_make_service())
                        .await
                    {
                        eprintln!(
                            "{}",
                            serde_json::json!({
                                "event": "backend_relay.serve_error",
                                "error": error.to_string(),
                            })
                        );
                    }
                }
                Err(error) => eprintln!(
                    "{}",
                    serde_json::json!({
                        "event": "backend_relay.tls_error",
                        "error": error.to_string(),
                    })
                ),
            }
        });
    }

    println!(
        "multivibe rust v1 edge listening on {}:{} (control_plane={})",
        config.listen_host, config.listen_port, config.node_control_plane_url
    );

    axum::serve(listener, router)
        .with_graceful_shutdown(shutdown_signal(shutdown_state))
        .await?;
    model_catalog_monitor.abort();
    if let Some(job_runner) = job_runner {
        job_runner.abort();
    }
    Ok(())
}

async fn shutdown_signal(state: multivibe_v1_edge::EdgeState) {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            eprintln!("failed to install Ctrl-C handler: {error}");
        }
    };

    #[cfg(unix)]
    {
        let terminate = async {
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(mut signal) => {
                    signal.recv().await;
                }
                Err(error) => eprintln!("failed to install SIGTERM handler: {error}"),
            }
        };
        tokio::select! {
            _ = ctrl_c => {},
            _ = terminate => {},
        }
    }

    #[cfg(not(unix))]
    ctrl_c.await;

    // Stop admitting new turns, then let live WebSocket connections finish the
    // current generation and close with code 1001. Axum's graceful shutdown
    // waits for the remaining connections after this future resolves.
    state.begin_shutdown();
    eprintln!(
        "{}",
        serde_json::json!({
            "event": "server.shutdown",
            "draining": true,
            "shutdownGraceMs": state.config.shutdown_grace.as_millis() as u64,
        })
    );
}
