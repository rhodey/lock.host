use tokio;
use std::fs;
use serde_bytes::ByteBuf;
use aws_nitro_enclaves_nsm_api::api::{Request, Response};
use aws_nitro_enclaves_nsm_api::driver::{nsm_init, nsm_process_request};

fn is_prod() -> bool {
    match std::env::var("PROD") {
        Ok(val) => matches!(
            val.trim().to_lowercase().as_str(),
            "1" | "true"
        ),
        Err(_) => false,
    }
}

fn unwrap_or_empty(arg: Option<ByteBuf>) -> String {
    let buf = arg.unwrap_or_else(|| ByteBuf::with_capacity(0));
    base64::encode(buf)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 4 {
        eprintln!("{} <public_key> <nonce> <user_data>", args[0]);
        std::process::exit(1);
    }

    let public_key = if args[1] != "null" {
        let bytes = base64::decode(args[1].clone())?;
        Some(ByteBuf::from(bytes))
    } else {
        None
    };
    eprintln!("ok public_key");

    let nonce = if args[2] != "null" {
        let bytes = base64::decode(args[2].clone())?;
        Some(ByteBuf::from(bytes))
    } else {
        None
    };
    eprintln!("ok nonce");

    let user_data = if args[3] != "null" {
        let bytes = base64::decode(args[3].clone())?;
        Some(ByteBuf::from(bytes))
    } else {
        None
    };
    eprintln!("ok user_data");

    if is_prod() == false {
        let public_key = unwrap_or_empty(public_key);
        let nonce = unwrap_or_empty(nonce);
        let user_data = unwrap_or_empty(user_data);
        let pcr_0 = fs::read_to_string("/hash.txt")?;
        let zeros = "0000000000000000000000000000000000000000000000000000000000000000";
        let doc = format!("testdoc,{},{},{},{},{},{}", public_key, nonce, user_data, pcr_0, zeros, zeros);
        let doc = base64::encode(doc);
        println!("{}", doc);
        return Ok(())
    }

    let nsm_fd = nsm_init();
    eprintln!("ok nsm_init");

    let request = Request::Attestation {
        public_key: public_key, nonce: nonce,
        user_data: user_data,
    };

    let response = nsm_process_request(nsm_fd, request);
    eprintln!("ok nsm_process_request");

    let doc = match response {
        Response::Attestation { document } => { document },
        _ => panic!("error get doc from response"),
    };

    let doc = base64::encode(doc);
    println!("{}", doc);
    Ok(())
}
