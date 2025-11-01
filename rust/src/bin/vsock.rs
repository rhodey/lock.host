use tokio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_vsock::{VsockListener, VsockAddr, VsockStream};

const PORT: u32 = 4444;
const CID_ANY: u32 = 0xFFFFFFFF;
const READ_BUF_LEN: usize = 8192;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {

    let args: Vec<String> = std::env::args().collect();
    if args.len() != 2 {
        eprintln!("{} <cid>", args[0]);
        std::process::exit(1);
    }

    let vsock;
    let cid: u32 = args[1].parse().expect("cid = number");

    if cid == 0 {
        let addr = VsockAddr::new(CID_ANY, PORT);
        let mut listen = VsockListener::bind(addr)?;
        let (stream, _peer_addr) = listen.accept().await?;
        vsock = stream;
    } else {
        let addr = VsockAddr::new(cid, PORT);
        vsock = VsockStream::connect(addr).await?;
    }

    let (mut vsock_read, mut vsock_write) = vsock.into_split();

    tokio::spawn(async move {
        let mut stdin = tokio::io::stdin();
        let mut buf = [0u8; READ_BUF_LEN];

        loop {
            match stdin.read(&mut buf).await {
                Ok(0) => {
                    eprintln!("stdin EOF");
                    break;
                },
                Ok(n) => {
                    if let Err(e) = vsock_write.write_all(&buf[..n]).await {
                        eprintln!("vsock write_all err: {}", e);
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("stdin read err: {}", e);
                    break;
                }
            }
        }
    });

    tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        let mut buf = [0u8; READ_BUF_LEN];

        loop {
            match vsock_read.read(&mut buf).await {
                Ok(0) => {
                    eprintln!("vsock EOF");
                    break;
                },
                Ok(n) => {
                    if let Err(e) = stdout.write_all(&buf[..n]).await {
                        eprintln!("stdout write_all err: {}", e);
                        break;
                    }
                    let _ = stdout.flush().await;
                }
                Err(e) => {
                    eprintln!("vsock read err: {}", e);
                    break;
                }
            }
        }
    });

    tokio::signal::ctrl_c().await?;
    Ok(())
}
