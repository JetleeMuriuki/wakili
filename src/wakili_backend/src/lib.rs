use candid::{CandidType, Deserialize, Principal};
use ic_cdk::api::management_canister::http_request::{
    http_request, CanisterHttpRequestArgument, HttpHeader, HttpMethod, HttpResponse, TransformArgs,
    TransformContext, TransformFunc,
};
use ic_cdk::{query, update};
use ic_cdk_macros::export_candid;
use serde_json;
use std::cell::RefCell;
use std::collections::HashMap;

// Custom getrandom implementation for IC
use getrandom::{register_custom_getrandom, Error};

fn custom_getrandom(buf: &mut [u8]) -> Result<(), Error> {
    for (i, byte) in buf.iter_mut().enumerate() {
        *byte = ((ic_cdk::api::time() + i as u64) % 256) as u8;
    }
    Ok(())
}

register_custom_getrandom!(custom_getrandom);

thread_local! {
    static DOCUMENT_STORE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
    static USER_PROFILES: RefCell<HashMap<Principal, UserProfile>> = RefCell::new(HashMap::new());
}

#[derive(CandidType, Deserialize, Clone)]
struct UserProfile {
    name: Option<String>,
    document_count: u32,
    last_active: u64,
}

#[derive(CandidType, Deserialize)]
pub struct LegalRequest {
    prompt: String,
    document_type: Option<String>,
    context: Option<String>,
    is_confidential: Option<bool>,
}

#[derive(CandidType, Deserialize)]
pub struct LegalResponse {
    response: String,
    document: Option<String>,
    status: String,
    request_id: Option<String>,
}

#[derive(serde::Serialize)]
struct ProxyRequest {
    prompt: String,
    max_tokens: Option<u32>,
    temperature: Option<f32>,
    is_legal: bool,
}

#[derive(serde::Deserialize)]
struct ProxyResponse {
    success: bool,
    result: Option<String>,
    error: Option<String>,
}

// Configuration - change this to your deployed proxy URL for production
const PROXY_URL: &str = "http://localhost:3000/openai";
const AUTH_TOKEN: &str = "your_secure_token_here"; // Should match your .env file

#[update]
async fn generate_legal_advice(request: LegalRequest) -> Result<LegalResponse, String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        return Err("Unauthorized: Internet Identity required".to_string());
    }

    update_user_profile(&caller);

    let prompt = format!(
        "As a legal AI advisor, provide {} advice for: {}. Context: {}. {}",
        request.document_type.as_ref().map_or("general", |t| t.as_str()),
        request.prompt,
        request.context.as_ref().map_or("no additional context", |c| c.as_str()),
        if request.is_confidential.unwrap_or(false) {
            "This request is confidential - do not include any identifying information in the response."
        } else {
            ""
        }
    );

    let proxy_request = ProxyRequest {
        prompt,
        max_tokens: Some(1000),
        temperature: Some(0.7),
        is_legal: true,
    };

    match call_openai_proxy(proxy_request).await {
        Ok(response) => {
            let document = if request.document_type.is_some() {
                Some(generate_document(&response, &request.document_type.unwrap()))
            } else {
                None
            };

            Ok(LegalResponse {
                response,
                document,
                status: "success".to_string(),
                request_id: Some(ic_cdk::api::time().to_string()),
            })
        }
        Err(e) => Err(format!("OpenAI proxy error: {}", e)),
    }
}

#[update]
async fn generate_legal_document(request: LegalRequest) -> Result<LegalResponse, String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        return Err("Unauthorized: Internet Identity required".to_string());
    }

    update_user_profile(&caller);

    let document_type = request.document_type.ok_or("Document type is required")?;
    
    let prompt = format!(
        "Generate a professional legal {} document with these requirements: {}. Context: {}. {}",
        document_type,
        request.prompt,
        request.context.as_ref().map_or("no additional context", |c| c.as_str()),
        if request.is_confidential.unwrap_or(false) {
            "This document must be anonymized and not contain any identifying information."
        } else {
            ""
        }
    );

    let proxy_request = ProxyRequest {
        prompt,
        max_tokens: Some(1500),
        temperature: Some(0.5),
        is_legal: true,
    };

    match call_openai_proxy(proxy_request).await {
        Ok(response) => {
            let document = generate_document(&response, &document_type);
            
            // Store the document
            let doc_id = format!("doc_{}_{}", caller.to_text(), ic_cdk::api::time());
            DOCUMENT_STORE.with(|store| {
                store.borrow_mut().insert(doc_id.clone(), document.clone());
            });

            // Update user document count
            USER_PROFILES.with(|profiles| {
                let mut profiles = profiles.borrow_mut();
                if let Some(profile) = profiles.get_mut(&caller) {
                    profile.document_count += 1;
                    profile.last_active = ic_cdk::api::time();
                }
            });

            Ok(LegalResponse {
                response: "Document generated successfully".to_string(),
                document: Some(document),
                status: "success".to_string(),
                request_id: Some(doc_id),
            })
        }
        Err(e) => Err(format!("OpenAI proxy error: {}", e)),
    }
}

#[query]
fn get_document(doc_id: String) -> Result<String, String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        return Err("Unauthorized: Internet Identity required".to_string());
    }

    DOCUMENT_STORE.with(|store| {
        store
            .borrow()
            .get(&doc_id)
            .cloned()
            .ok_or("Document not found".to_string())
    })
}

#[query]
fn get_user_documents() -> Result<Vec<(String, String)>, String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        return Err("Unauthorized: Internet Identity required".to_string());
    }

    let prefix = format!("doc_{}_", caller.to_text());
    
    DOCUMENT_STORE.with(|store| {
        Ok(store
            .borrow()
            .iter()
            .filter(|(k, _)| k.starts_with(&prefix))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect())
    })
}

#[query]
fn get_user_profile() -> Result<UserProfile, String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        return Err("Unauthorized: Internet Identity required".to_string());
    }

    USER_PROFILES.with(|profiles| {
        profiles
            .borrow()
            .get(&caller)
            .cloned()
            .ok_or("Profile not found".to_string())
    })
}

#[update]
fn update_user_name(name: String) -> Result<(), String> {
    let caller = ic_cdk::caller();
    if caller == Principal::anonymous() {
        return Err("Unauthorized: Internet Identity required".to_string());
    }

    USER_PROFILES.with(|profiles| {
        let mut profiles = profiles.borrow_mut();
        let profile = profiles.entry(caller).or_insert_with(|| UserProfile {
            name: None,
            document_count: 0,
            last_active: ic_cdk::api::time(),
        });
        profile.name = Some(name);
        profile.last_active = ic_cdk::api::time();
    });

    Ok(())
}

// HTTP outcall to Node.js proxy
async fn call_openai_proxy(request: ProxyRequest) -> Result<String, String> {
    let json_body = serde_json::to_string(&request)
        .map_err(|e| format!("Failed to serialize request: {}", e))?;

    let request_headers = vec![
        HttpHeader {
            name: "Content-Type".to_string(),
            value: "application/json".to_string(),
        },
        HttpHeader {
            name: "Authorization".to_string(),
            value: format!("Bearer {}", AUTH_TOKEN),
        },
    ];

    let http_request_arg = CanisterHttpRequestArgument {
        url: PROXY_URL.to_string(),
        method: HttpMethod::POST,
        body: Some(json_body.into_bytes()),
        max_response_bytes: Some(8192), // Increased for longer responses
        transform: Some(TransformContext {
            function: TransformFunc(candid::Func {
                principal: ic_cdk::api::id(),
                method: "transform_response".to_string(),
            }),
            context: vec![],
        }),
        headers: request_headers,
    };

    match http_request(http_request_arg, 25_000_000_000u128).await {
        Ok((response,)) => {
            if response.status != 200u16 {
                return Err(format!("HTTP error: status {}", response.status));
            }

            let response_body = String::from_utf8(response.body)
                .map_err(|_| "Failed to parse response body as UTF-8")?;
            
            let proxy_response: ProxyResponse = serde_json::from_str(&response_body)
                .map_err(|e| format!("Failed to parse JSON response: {}", e))?;

            if proxy_response.success {
                proxy_response.result
                    .ok_or_else(|| "No result in successful response".to_string())
            } else {
                Err(proxy_response.error
                    .unwrap_or_else(|| "Unknown proxy error".to_string()))
            }
        }
        Err((r, m)) => Err(format!("HTTP request failed: {:?} - {}", r, m)),
    }
}

// Transform function for HTTP outcalls
#[query]
fn transform_response(raw: TransformArgs) -> HttpResponse {
    let headers = vec![
        HttpHeader {
            name: "content-security-policy".to_string(),
            value: "default-src 'self'".to_string(),
        },
        HttpHeader {
            name: "referrer-policy".to_string(),
            value: "strict-origin".to_string(),
        },
    ];

    HttpResponse {
        status: raw.response.status.clone(),
        body: raw.response.body.clone(),
        headers,
    }
}

fn generate_document(content: &str, doc_type: &str) -> String {
    format!(
        "LEGAL DOCUMENT: {}\n\n{}\n\n---\nGenerated by Wakili Legal AI Advisor\nTimestamp: {}\n\nDISCLAIMER: This document was generated by AI and should be reviewed by a qualified legal professional before use.",
        doc_type.to_uppercase(),
        content,
        ic_cdk::api::time()
    )
}

fn update_user_profile(principal: &Principal) {
    USER_PROFILES.with(|profiles| {
        let mut profiles = profiles.borrow_mut();
        profiles.entry(*principal).or_insert_with(|| UserProfile {
            name: None,
            document_count: 0,
            last_active: ic_cdk::api::time(),
        }).last_active = ic_cdk::api::time();
    });
}

// Export the Candid interface
export_candid!();