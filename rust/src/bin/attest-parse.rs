#![cfg(feature = "ssl")]
use tokio;
use aws_nitro_enclaves_cose::CoseSign1;
use aws_nitro_enclaves_cose::crypto::{Openssl};
use aws_nitro_enclaves_nsm_api::api::AttestationDoc;
use lockhost_runtime::cert::{load_root_certificate, verify_cabundle, verify_signature};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("{} <attest_doc> [root.pem]", args[0]);
        std::process::exit(1);
    }

    let attest_doc: String = args[1].clone();
    let attest_doc = base64::decode(attest_doc)?;
    eprintln!("have attest doc");

    let root_pem_path = "./root.pem".to_string();
    let root_pem_path = args.get(2).unwrap_or(&root_pem_path);

    let test_doc = String::from_utf8_lossy(&attest_doc);
    if test_doc.starts_with("testdoc,") == true {
      let mut parts: Vec<&str> = test_doc.split(',').collect();
      parts.remove(0);
      parts.truncate(3);
      // public_key, nonce, user_data
      let parts = parts.join(",");
      // test doc must always have pcrs = zeros
      let pcr = "000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";
      println!("{},{},{},{}", parts, pcr, pcr, pcr);
      return Ok(())
    }

    let cose_sign = CoseSign1::from_bytes(&attest_doc)?;
    let payload = cose_sign.get_payload::<Openssl>(None)?;
    let doc: AttestationDoc = ciborium::de::from_reader(payload.as_slice())?;
    eprintln!("attest_doc decoded");

    let root_cert = load_root_certificate(root_pem_path)?;
    let valid_chain = verify_cabundle(&doc, root_cert)?;
    assert!(valid_chain, "certificate chain validation failed");
    eprintln!("certificate chain is valid");

    let valid_signature = verify_signature(&cose_sign, &doc)?;
    assert!(valid_signature, "attest doc signature validation failed");
    eprintln!("attest_doc signature is valid");

    if let Some(public_key) = doc.public_key {
        print!("{},", base64::encode(public_key));
    } else {
        print!(",")
    }

    if let Some(nonce) = doc.nonce {
        print!("{},", base64::encode(nonce));
    } else {
        print!(",")
    }

    if let Some(user_data) = doc.user_data {
        print!("{},", base64::encode(user_data));
    } else {
        print!(",")
    }

    for &index in &[0, 1, 2] {
        if let Some(pcr_entry) = doc.pcrs.get(&index) {
            print!("{},", hex::encode(pcr_entry));
        } else {
            print!(",");
        }
    }
    Ok(())
}
