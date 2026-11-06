// Optional Google sign-in. Signed out, the hub works exactly as before (saves stay in this browser).
// Signed in, saves and settings follow the account across devices via cloudSync.mjs.
import { authProvider, auth } from "./firebase.mjs";
import { startSync, stopSync, syncNow, onSyncStatus } from "./cloudSync.mjs";

// Static markup only; nothing user-supplied is ever put into HTML strings in this file.
const GOOGLE_G = `<svg class="account-g" viewBox="0 0 48 48" aria-hidden="true">
<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
</svg>`;

const QUIET_ERRORS = new Set(['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/user-cancelled']);
const ERROR_MESSAGES = {
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow pop-ups for this site and try again.',
    'auth/unauthorized-domain': "This site's address hasn't been approved for Google sign-in yet.",
    'auth/operation-not-allowed': "Google sign-in isn't switched on for this project yet.",
    'auth/network-request-failed': "Couldn't reach Google. Check your connection and try again.",
};

let $btn, $panel, $msg, $name, $email, $status, $dot;
let currentStatus = { state: 'off' };
let msgTimer = null;
let busy = false;

export function initAccount() {
    $btn = $('<button type="button" id="account-btn" class="theme-toggle-btn account-btn" aria-haspopup="true"></button>');
    $msg = $('<div id="account-msg" class="account-msg" role="status" hidden></div>');
    $panel = buildPanel();
    $('body').append($btn, $panel, $msg);

    $btn.on('click', (e) => {
        e.stopPropagation();
        if (isGoogleUser(authProvider.currentUser)) togglePanel();
        else signIn();
    });
    $(document).on('click', (e) => {
        if (!$panel.prop('hidden') && !$(e.target).closest('#account-panel').length) closePanel();
    });
    $(document).on('keydown', (e) => {
        if (e.key === 'Escape') closePanel();
    });

    onSyncStatus((s) => {
        currentStatus = s;
        renderStatus();
    });
    // Re-render the "synced 2 min ago" text while the panel is open.
    setInterval(() => { if (!$panel.prop('hidden')) renderStatus(); }, 30_000);

    renderSignedOut();
    auth.onAuthStateChanged(authProvider, handleUser);
}

function isGoogleUser(user) {
    return !!user && user.providerData.some((p) => p.providerId === 'google.com');
}

function handleUser(user) {
    if (isGoogleUser(user)) {
        renderSignedIn(user);
        startSync(user.uid, { askChoice });
    } else {
        stopSync();
        closePanel();
        renderSignedOut();
    }
}

async function signIn() {
    if (busy) return;
    busy = true;
    $btn.prop('disabled', true);
    try {
        const provider = new auth.GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        const current = authProvider.currentUser;
        try {
            // Visitors are signed in anonymously for the visit counter. Linking keeps that profile.
            if (current?.isAnonymous) await auth.linkWithPopup(current, provider);
            else await auth.signInWithPopup(authProvider, provider);
        } catch (err) {
            if (err?.code !== 'auth/credential-already-in-use') throw err;
            // This Google account already has saves from another device; sign in to it instead.
            const credential = auth.GoogleAuthProvider.credentialFromError(err);
            if (!credential) throw err;
            await auth.signInWithCredential(authProvider, credential);
        }
        handleUser(authProvider.currentUser); // linking doesn't fire onAuthStateChanged
    } catch (err) {
        if (!QUIET_ERRORS.has(err?.code)) {
            console.warn('Google sign-in failed:', err);
            showMessage(ERROR_MESSAGES[err?.code] ?? 'Sign-in failed. Please try again.');
        }
    } finally {
        busy = false;
        $btn.prop('disabled', false);
    }
}

async function signOut() {
    $panel.find('button').prop('disabled', true);
    // Upload anything unsynced first; once signed out we can no longer write to the account.
    await Promise.race([syncNow().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 4000))]);
    try {
        await auth.signOut(authProvider);
    } catch (err) {
        console.warn('Sign-out failed:', err);
        showMessage('Sign-out failed. Please try again.');
        $panel.find('button').prop('disabled', false);
    }
}

function buildPanel() {
    $name = $('<div class="account-name"></div>');
    $email = $('<div class="account-email"></div>');
    $dot = $('<span class="account-dot" aria-hidden="true"></span>');
    $status = $('<span class="account-status"></span>');
    const $syncNow = $('<button type="button" class="account-action">Sync now</button>')
        .on('click', () => syncNow());
    const $signOut = $('<button type="button" class="account-action">Sign out</button>')
        .on('click', signOut);

    return $('<div id="account-panel" class="account-panel" hidden></div>').append(
        $name,
        $email,
        $('<div class="account-sync"></div>').append($dot, $status),
        $('<p class="account-note">Saves stay on this device when you sign out.</p>'),
        $('<div class="account-actions"></div>').append($syncNow, $signOut),
    );
}

function renderSignedOut() {
    $btn.empty()
        .append($(GOOGLE_G), $('<span class="account-label"></span>').text('Sign in with Google'))
        .attr({ title: 'Optional: sign in to keep your saves across devices', 'aria-label': 'Sign in with Google' })
        .removeClass('signed-in');
}

function renderSignedIn(user) {
    const info = user.providerData.find((p) => p.providerId === 'google.com') ?? {};
    const name = user.displayName || info.displayName || 'Signed in';
    const email = user.email || info.email || '';
    const photo = user.photoURL || info.photoURL;

    $name.text(name);
    $email.text(email);
    $btn.empty().addClass('signed-in');
    $btn.append(photo
        ? $('<img class="account-avatar" alt="" referrerpolicy="no-referrer">').attr('src', photo)
        : $(GOOGLE_G));
    $btn.append($('<span class="account-label"></span>').text(name.split(' ')[0]))
        .attr({ title: 'Account and sync', 'aria-label': `Account: ${name}` });
    renderStatus();
}

function renderStatus() {
    const { state, at, message } = currentStatus;
    let text = '';
    if (state === 'syncing') text = 'Syncing…';
    else if (state === 'synced') text = `Saved to your account · ${ago(at)}`;
    else if (state === 'paused' || state === 'error') text = message;
    $status.text(text);
    $dot.attr('class', `account-dot ${state}`);
}

function ago(ms) {
    const seconds = Math.round((Date.now() - ms) / 1000);
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.round(minutes / 60)} h ago`;
}

function togglePanel() {
    const open = $panel.prop('hidden');
    $panel.prop('hidden', !open);
    $btn.attr('aria-expanded', String(open));
    if (open) renderStatus();
}

function closePanel() {
    $panel.prop('hidden', true);
    $btn.attr('aria-expanded', 'false');
}

function showMessage(text) {
    clearTimeout(msgTimer);
    $msg.text(text).prop('hidden', false);
    msgTimer = setTimeout(() => $msg.prop('hidden', true), 7000);
}

/** First sync on this device and the cloud disagrees about some saves: ask which to keep. */
function askChoice(conflictKeys) {
    return new Promise((resolve) => {
        const n = conflictKeys.length;
        const done = (choice) => {
            $backdrop.remove();
            resolve(choice);
        };
        const $backdrop = $('<div class="account-backdrop"></div>').append(
            $('<div class="account-modal" role="dialog" aria-modal="true" aria-labelledby="account-modal-title"></div>').append(
                $('<h2 id="account-modal-title">Which saves should we keep?</h2>'),
                $('<p></p>').text(
                    `Your account already has saves, and ${n} saved item${n === 1 ? '' : 's'} on this device ` +
                    `${n === 1 ? 'is' : 'are'} different. Everything else is merged automatically.`,
                ),
                $('<button type="button" class="account-action primary"></button>')
                    .append($('<strong>Use my account\'s saves</strong>'), $('<span>Replaces the differing items on this device. Best for a new device.</span>'))
                    .on('click', () => done('cloud')),
                $('<button type="button" class="account-action"></button>')
                    .append($('<strong>Keep this device\'s saves</strong>'), $('<span>Overwrites the differing items in your account.</span>'))
                    .on('click', () => done('device')),
                $('<button type="button" class="account-link">Decide later</button>')
                    .on('click', () => done(null)),
            ),
        );
        $('body').append($backdrop);
        $backdrop.find('.primary').trigger('focus');
    });
}
