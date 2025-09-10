use tokio;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio_vsock::{VsockListener, VsockAddr, VsockStream};
use std::io::{self, BufRead, BufReader};

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

    let (vsock_read, vsock_write) = vsock.into_split();

    tokio::spawn(async move {
        let stdin = io::stdin();
        let mut stdin_read = BufReader::new(stdin);
        let mut vsock_write = vsock_write;

        loop {
            let mut line = String::new();
            match stdin_read.read_line(&mut line) {
                Ok(0) => {
                    eprintln!("EOF");
                    break;
                },
                Ok(_) => {
                    let tx_buf = format!("{}\n", line);
                    vsock_write.write_all(tx_buf.as_bytes()).await.unwrap();
                }
                Err(e) => {
                    eprintln!("stdin read_line err: {}", e);
                    break;
                }
            }
        }
    });

    tokio::spawn(async move {
        let mut vsock_read = vsock_read;
        loop {
          let mut rx_buf = [0u8; READ_BUF_LEN];
          let rx_len = vsock_read.read(&mut rx_buf).await.unwrap();
          let rx_str = std::str::from_utf8(&rx_buf[..rx_len]).unwrap();
          print!("{}", rx_str);
        }
    });

    tokio::signal::ctrl_c().await?;
    Ok(())
}
