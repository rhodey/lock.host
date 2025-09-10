#![cfg(feature = "ssl")]

use std::fs;

use aws_nitro_enclaves_cose::CoseSign1;
use aws_nitro_enclaves_cose::crypto::{Openssl};
use aws_nitro_enclaves_nsm_api::api::AttestationDoc;
use openssl::stack::Stack;
use openssl::x509::X509;
use openssl::x509::store::X509StoreBuilder;
use openssl::x509::X509StoreContext;

pub fn load_root_certificate(path: &str) -> Result<X509, Box<dyn std::error::Error>> {
    let root_cert_pem = fs::read(path)?;
    let root_cert = X509::from_pem(&root_cert_pem)?;

    Ok(root_cert)
}

// Test that the cert in the doc is authorized by the root
pub fn verify_cabundle(attestation_doc: &AttestationDoc, root_cert: X509) -> Result<bool, Box<dyn std::error::Error>> {
    // Add AWS root cert
    let mut store_builder = X509StoreBuilder::new()?;
    store_builder.add_cert(root_cert)?;
    let store = store_builder.build();

    // Build chain of intermediate certificates in reverse order
    let mut cert_chain = Stack::new()?;
    for cert_bytes in attestation_doc.cabundle.iter().skip(1).rev() {
        let intermediate_cert = X509::from_der(cert_bytes)?;
        cert_chain.push(intermediate_cert)?;
    }

    // Test that the cert in the doc is valid given the root
    let doc_cert = X509::from_der(&attestation_doc.certificate)?;
    let mut store_ctx = X509StoreContext::new()?;
    let verification_result = store_ctx.init(&store, &doc_cert, &cert_chain, |ctx| {
        ctx.verify_cert()
    })?;

    Ok(verification_result)
}

// Test that the doc was signed by the authorized cert
pub fn verify_signature(cose_sign: &CoseSign1, attestation_doc: &AttestationDoc) -> Result<bool, Box<dyn std::error::Error>> {
    let cert = X509::from_der(attestation_doc.certificate.as_ref())?;
    let public_key = cert.public_key()?;

    Ok(cose_sign.verify_signature::<Openssl>(&public_key).unwrap())
}
