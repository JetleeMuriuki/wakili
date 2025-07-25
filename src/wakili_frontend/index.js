import { Actor, HttpAgent } from '@dfinity/agent';
import { AuthClient } from '@dfinity/auth-client';
import { idlFactory as wakiliIdlFactory } from '../declarations/wakili_backend/wakili_backend.did.js';
import { idlFactory as internetIdentityIdlFactory } from '../declarations/internet_identity/internet_identity.did.js';

// UI Elements
const loginButton = document.getElementById('loginButton');
const authSection = document.getElementById('authSection');
const appContent = document.getElementById('appContent');
const getAdviceBtn = document.getElementById('getAdviceBtn');
const generateDocBtn = document.getElementById('generateDocBtn');
const responseArea = document.getElementById('responseArea');
const documentOutput = document.getElementById('documentOutput');
const downloadDocBtn = document.getElementById('downloadDocBtn');
const saveDocBtn = document.getElementById('saveDocBtn');
const documentsList = document.getElementById('documentsList');
const updateNameBtn = document.getElementById('updateNameBtn');
const userNameInput = document.getElementById('userNameInput');
const userNameDisplay = document.getElementById('userName');
const userStatsDisplay = document.getElementById('userStats');
const lastActiveDisplay = document.getElementById('lastActive');

let actor;
let internetIdentityActor;
let currentDocument = null;
let currentPrincipal = null;

// Initialize Internet Identity
const initII = async () => {
    try {
        const authClient = await window.ic.plug.createAgent({
            whitelist: [
                process.env.WAKILI_BACKEND_CANISTER_ID,
                process.env.INTERNET_IDENTITY_CANISTER_ID
            ],
            host: process.env.DFX_NETWORK === 'ic' ? 'https://ic0.app' : 'http://localhost:4943'
        });
        
        if (await authClient.isAuthenticated()) {
            await handleAuthenticated(authClient);
        } else {
            loginButton.onclick = async () => {
                await authClient.login();
                if (await authClient.isAuthenticated()) {
                    await handleAuthenticated(authClient);
                }
            };
        }
    } catch (error) {
        console.error('Error initializing Internet Identity:', error);
        showAlert('Error initializing authentication. Please try again.', 'danger');
    }
};

const handleAuthenticated = async (authClient) => {
    currentPrincipal = authClient.getPrincipal();
    authSection.classList.add('d-none');
    appContent.classList.remove('d-none');
    
    // Initialize actors
    const agent = new HttpAgent({ 
        identity: authClient.getIdentity(),
        host: process.env.DFX_NETWORK === 'ic' ? 'https://ic0.app' : 'http://127.0.0.1:4943'
    });
    
    if (process.env.DFX_NETWORK !== 'ic') {
        await agent.fetchRootKey();
    }
    
    actor = Actor.createActor(wakiliIdlFactory, {
        agent,
        canisterId: process.env.WAKILI_BACKEND_CANISTER_ID
    });
    
    internetIdentityActor = Actor.createActor(internetIdentityIdlFactory, {
        agent,
        canisterId: process.env.INTERNET_IDENTITY_CANISTER_ID
    });
    
    // Load user data
    loadUserProfile();
    loadUserDocuments();
};

// Event Listeners
getAdviceBtn.addEventListener('click', async () => {
    const prompt = document.getElementById('advicePrompt').value;
    const context = document.getElementById('adviceContext').value;
    const isConfidential = document.getElementById('confidentialCheck').checked;
    
    if (!prompt) {
        showAlert('Please enter your legal question', 'warning');
        return;
    }
    
    try {
        toggleButton(getAdviceBtn, true);
        
        const request = {
            prompt,
            document_type: null,
            context: context || null,
            is_confidential: isConfidential
        };
        
        const response = await actor.generate_legal_advice(request);
        
        if (response.status === 'success') {
            displayResponse(response.response);
            currentDocument = null;
            documentOutput.classList.add('d-none');
        } else {
            throw new Error(response);
        }
    } catch (error) {
        console.error('Error getting legal advice:', error);
        displayResponse(`Error: ${error.message || 'Failed to get legal advice'}`);
    } finally {
        toggleButton(getAdviceBtn, false);
        loadUserProfile(); // Refresh profile
    }
});

generateDocBtn.addEventListener('click', async () => {
    const docType = document.getElementById('docType').value;
    const prompt = document.getElementById('docPrompt').value;
    const context = document.getElementById('docContext').value;
    const isConfidential = document.getElementById('docConfidentialCheck').checked;
    
    if (!prompt) {
        showAlert('Please describe the document you need', 'warning');
        return;
    }
    
    try {
        toggleButton(generateDocBtn, true);
        
        const request = {
            prompt,
            document_type: docType,
            context: context || null,
            is_confidential: isConfidential
        };
        
        const response = await actor.generate_legal_document(request);
        
        if (response.status === 'success' && response.document) {
            displayResponse(response.document);
            currentDocument = response.document;
            documentOutput.classList.remove('d-none');
        } else {
            throw new Error('Document generation failed');
        }
    } catch (error) {
        console.error('Error generating document:', error);
        displayResponse(`Error: ${error.message || 'Failed to generate document'}`);
    } finally {
        toggleButton(generateDocBtn, false);
        loadUserProfile(); // Refresh profile
    }
});

downloadDocBtn.addEventListener('click', () => {
    if (!currentDocument) return;
    
    const blob = new Blob([currentDocument], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `legal_document_${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
});

saveDocBtn.addEventListener('click', async () => {
    if (!currentDocument) return;
    
    try {
        toggleButton(saveDocBtn, true);
        loadUserDocuments(); // Refresh the list
        showAlert('Document saved successfully!', 'success');
    } catch (error) {
        console.error('Error saving document:', error);
        showAlert('Failed to save document', 'danger');
    } finally {
        toggleButton(saveDocBtn, false);
    }
});

updateNameBtn.addEventListener('click', async () => {
    const name = userNameInput.value.trim();
    if (!name) {
        showAlert('Please enter a name', 'warning');
        return;
    }
    
    try {
        toggleButton(updateNameBtn, true);
        await actor.update_user_name(name);
        loadUserProfile();
        showAlert('Name updated successfully!', 'success');
    } catch (error) {
        console.error('Error updating name:', error);
        showAlert('Failed to update name', 'danger');
    } finally {
        toggleButton(updateNameBtn, false);
    }
});

// Helper Functions
const displayResponse = (text) => {
    responseArea.innerHTML = text
        .replace(/\n/g, '<br>')
        .replace(/IMPORTANT:/g, '<strong>IMPORTANT:</strong>')
        .replace(/NOTE:/g, '<strong>NOTE:</strong>')
        .replace(/DISCLAIMER:/g, '<strong>DISCLAIMER:</strong>');
    responseArea.scrollIntoView({ behavior: 'smooth' });
};

const loadUserProfile = async () => {
    try {
        const profile = await actor.get_user_profile();
        
        userNameDisplay.textContent = profile.name.unwrap_or('User');
        userStatsDisplay.textContent = `${profile.document_count} documents generated`;
        
        const lastActiveDate = new Date(Number(profile.last_active / 1000000n));
        lastActiveDisplay.textContent = `Last active: ${formatDate(lastActiveDate)}`;
        
        if (profile.name.length > 0) {
            userNameInput.value = profile.name[0];
        }
    } catch (error) {
        console.error('Error loading user profile:', error);
    }
};

const loadUserDocuments = async () => {
    try {
        const docs = await actor.get_user_documents();
        
        if (docs.length === 0) {
            documentsList.innerHTML = `
                <div class="text-center py-3">
                    <p class="text-muted">No documents found. Generate one to get started!</p>
                </div>
            `;
            return;
        }
        
        documentsList.innerHTML = '';
        
        docs.forEach(([docId, content]) => {
            const docPreview = content.length > 100 ? content.substring(0, 100) + '...' : content;
            const docDate = new Date(Number(docId.split('_')[2] / 1000000n));
            
            const docElement = document.createElement('div');
            docElement.className = 'list-group-item document-card';
            docElement.innerHTML = `
                <div class="d-flex w-100 justify-content-between">
                    <h5 class="mb-1">${docId.split('_')[1]}</h5>
                    <small>${formatDate(docDate)}</small>
                </div>
                <p class="mb-1">${docPreview}</p>
                <small>
                    <button class="btn btn-sm btn-outline-primary view-doc-btn" data-doc-id="${docId}">
                        <i class="fas fa-eye me-1"></i>View
                    </button>
                </small>
            `;
            
            documentsList.appendChild(docElement);
        });
        
        // Add event listeners to view buttons
        document.querySelectorAll('.view-doc-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const docId = e.target.getAttribute('data-doc-id');
                try {
                    const docContent = await actor.get_document(docId);
                    displayResponse(docContent);
                    currentDocument = docContent;
                    documentOutput.classList.remove('d-none');
                } catch (error) {
                    console.error('Error fetching document:', error);
                    displayResponse('Error loading document');
                }
            });
        });
    } catch (error) {
        console.error('Error loading documents:', error);
        documentsList.innerHTML = `
            <div class="text-center py-3">
                <p class="text-danger">Error loading documents</p>
            </div>
        `;
    }
};

const formatDate = (date) => {
    return date.toLocaleString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
};

const toggleButton = (button, isLoading) => {
    const originalText = button.innerHTML;
    if (isLoading) {
        button.disabled = true;
        button.innerHTML = `<i class="fas fa-spinner fa-spin me-2"></i>${button.textContent.trim()}`;
    } else {
        button.disabled = false;
        button.innerHTML = originalText;
    }
};

const showAlert = (message, type) => {
    const alertDiv = document.createElement('div');
    alertDiv.className = `alert alert-${type} alert-dismissible fade show position-fixed top-0 end-0 m-3`;
    alertDiv.style.zIndex = '1100';
    alertDiv.role = 'alert';
    alertDiv.innerHTML = `
        ${message}
        <button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Close"></button>
    `;
    
    document.body.appendChild(alertDiv);
    
    // Auto-dismiss after 5 seconds
    setTimeout(() => {
        const bsAlert = new bootstrap.Alert(alertDiv);
        bsAlert.close();
    }, 5000);
};

// Initialize the app
window.onload = async () => {
    try {
        // Try Plug Wallet first
        if (window.ic?.plug) {
            await initII();
        } 
        // Fallback to Internet Identity directly
        else {
            const authClient = await AuthClient.create();
            if (await authClient.isAuthenticated()) {
                await handleAuthenticated(authClient);
            } else {
                loginButton.onclick = async () => {
                    await authClient.login({
                        identityProvider: "https://identity.ic0.app"
                    });
                    if (await authClient.isAuthenticated()) {
                        await handleAuthenticated(authClient);
                    }
                };
            }
        }
    } catch (error) {
        console.error('Auth error:', error);
        showAlert('Authentication failed. Try refreshing or install Plug Wallet.', 'danger');
    }
};