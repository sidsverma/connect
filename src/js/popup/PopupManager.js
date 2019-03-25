/* @flow */

import EventEmitter from 'events';
import * as POPUP from '../constants/popup';
import * as IFRAME from '../constants/iframe';
import * as UI from '../constants/ui';
import { showPopupRequest } from './showPopupRequest';
import type { ConnectSettings } from '../data/ConnectSettings';
import type { CoreMessage, Deferred } from '../types';
import { getOrigin } from '../utils/networkUtils';
import { create as createDeferred } from '../utils/deferred';

// const POPUP_REQUEST_TIMEOUT: number = 602;
const POPUP_REQUEST_TIMEOUT: number = 850;
const POPUP_CLOSE_INTERVAL: number = 500;
const POPUP_OPEN_TIMEOUT: number = 2000;

export default class PopupManager extends EventEmitter {
    _window: any; // Window
    settings: ConnectSettings;
    origin: string;
    locked: boolean;
    requestTimeout: number = 0;
    openTimeout: number;
    closeInterval: number = 0;
    iframeHandshake: Deferred<boolean>;
    handleMessage: (event: MessageEvent) => void;
    handleExtensionConnect: () => void;
    handleExtensionMessage: () => void;
    // $FlowIssue chrome not declared outside
    extensionPort: ?ChromePort;
    extensionTabId: number = 0;

    constructor(settings: ConnectSettings) {
        super();
        this.settings = settings;
        this.origin = getOrigin(settings.popupSrc);
        this.handleMessage = this.handleMessage.bind(this);
        this.iframeHandshake = createDeferred(IFRAME.LOADED);

        if (this.settings.env === 'webextension') {
            this.handleExtensionConnect = this.handleExtensionConnect.bind(this);
            this.handleExtensionMessage = this.handleExtensionMessage.bind(this);
            // $FlowIssue chrome not declared outside
            chrome.runtime.onConnect.addListener(this.handleExtensionConnect);
        }

        window.addEventListener('message', this.handleMessage, false);
    }

    request(lazyLoad: boolean = false): void {
        // popup request
        // TODO: ie - open imediately and hide it but post handshake after timeout

        // bring popup window to front
        if (this.locked) {
            if (this._window) {
                if (this.settings.env === 'webextension') {
                    // $FlowIssue chrome not declared outside
                    chrome.tabs.update(this._window.id, { active: true });
                } else {
                    this._window.focus();
                }
            }
            return;
        }

        const openFn: Function = this.open.bind(this);
        this.locked = true;
        if (!this.settings.supportedBrowser) {
            openFn();
        } else {
            const timeout = lazyLoad || this.settings.env === 'webextension' ? 1 : POPUP_REQUEST_TIMEOUT;
            this.requestTimeout = window.setTimeout(() => {
                this.requestTimeout = 0;
                openFn(lazyLoad);
            }, timeout);
        }
    }

    cancel(): void {
        this.close();
    }

    unlock(): void {
        this.locked = false;
    }

    open(lazyLoad?: boolean): void {
        const src = this.settings.popupSrc;
        if (!this.settings.supportedBrowser) {
            this.openWrapper(`${src}#unsupported`);
            return;
        }

        this.openWrapper(lazyLoad ? `${ src }#loading` : src);

        this.closeInterval = window.setInterval(() => {
            if (!this._window) return;
            if (this.settings.env === 'webextension') {
                // $FlowIssue chrome not declared outside
                chrome.tabs.get(this._window.id, tab => {
                    if (!tab) {
                        this.close();
                        this.emit(POPUP.CLOSED);
                    }
                });
            } else if (this._window.closed) {
                this.close();
                this.emit(POPUP.CLOSED);
            }
        }, POPUP_CLOSE_INTERVAL);

        // open timeout will be cancelled by POPUP.BOOTSTRAP message
        this.openTimeout = window.setTimeout(() => {
            this.close();
            showPopupRequest(this.open.bind(this), () => { this.emit(POPUP.CLOSED); });
        }, POPUP_OPEN_TIMEOUT);
    }

    openWrapper(url: string): void {
        if (this.settings.env === 'webextension') {
            // $FlowIssue chrome not declared outside
            chrome.windows.getCurrent(null, currentWindow => {
                // Request comming from extension popup,
                // create new window above instead of opening new tab
                if (currentWindow.type !== 'normal') {
                    // $FlowIssue chrome not declared outside
                    chrome.windows.create({ url }, newWindow => {
                        // $FlowIssue chrome not declared outside
                        chrome.tabs.query({
                            windowId: newWindow.id,
                            active: true,
                        }, tabs => {
                            this._window = tabs[0];
                        });
                    });
                } else {
                    // $FlowIssue chrome not declared outside
                    chrome.tabs.query({
                        currentWindow: true,
                        active: true,
                    }, (tabs) => {
                        this.extensionTabId = tabs[0].id;
                        // $FlowIssue chrome not declared outside
                        chrome.tabs.create({
                            url,
                            index: tabs[0].index + 1,
                        }, tab => {
                            this._window = tab;
                        });
                    });
                }
            });
        } else if (this.settings.env === 'electron') {
            this._window = window.open(url, 'modal');
        } else {
            this._window = window.open('', '_blank');
            if (this._window) {
                this._window.location.href = url; // otherwise android/chrome loose window.opener reference
            }
        }
    }

    handleExtensionConnect(port: ChromePort): void {
        if (port.name !== 'trezor-connect') return;
        if (!this._window || (this._window && this._window.id !== port.sender.tab.id)) {
            port.disconnect();
            return;
        }
        // since POPUP.BOOTSTRAP will not be handled by "handleMessage" we need to threat "content-script" connection as the same event
        // popup is opened properly, now wait for POPUP.LOADED message (in this case handled by "handleExtensionMessage")
        window.clearTimeout(this.openTimeout);

        this.extensionPort = port;
        this.extensionPort.onMessage.addListener(this.handleExtensionMessage);
    }

    handleExtensionMessage(message: MessageEvent): void {
        if (!this.extensionPort) return;
        const { data } = message;
        if (!data || typeof data !== 'object') return;

        if (data.type === POPUP.ERROR) {
            // handle popup error
            const errorMessage = (data.payload && typeof data.payload.error === 'string') ? data.payload.error : null;
            this.emit(POPUP.CLOSED, errorMessage ? { error: `Popup error: ${errorMessage}` } : null);
            this.close();
        } else if (data.type === POPUP.LOADED) {
            this.iframeHandshake.promise.then(resolve => {
                this.extensionPort.postMessage({
                    type: POPUP.INIT,
                    payload: {
                        settings: this.settings,
                    },
                });
            });
        } else if (data.type === POPUP.EXTENSION_USB_PERMISSIONS) {
            // $FlowIssue chrome not declared outside
            chrome.tabs.query({
                currentWindow: true,
                active: true,
            }, (tabs) => {
                // $FlowIssue chrome not declared outside
                chrome.tabs.create({
                    url: 'trezor-usb-permissions.html',
                    index: tabs[0].index + 1,
                }, tab => {
                    // do nothing
                });
            });
        } else if (data.type === POPUP.CLOSE_WINDOW) {
            this.emit(POPUP.CLOSED);
            this.close();
        }
    }

    handleMessage(message: MessageEvent): void {
        // ignore messages from domain other then popup origin and without data
        const { data } = message;
        if (getOrigin(message.origin) !== this.origin || !data || typeof data !== 'object') return;

        if (data.type === IFRAME.LOADED) {
            this.iframeHandshake.resolve(true);
        } else if (data.type === POPUP.BOOTSTRAP) {
            // popup is opened properly, now wait for POPUP.LOADED message
            window.clearTimeout(this.openTimeout);
        } else if (data.type === POPUP.ERROR) {
            const errorMessage = (data.payload && typeof data.payload.error === 'string') ? data.payload.error : null;
            this.emit(POPUP.CLOSED, errorMessage ? { error: `Popup error: ${errorMessage}` } : null);
            this.close();
        } else if (data.type === POPUP.LOADED) {
            // popup is successfully loaded
            this.iframeHandshake.promise.then(resolve => {
                this._window.postMessage({
                    type: POPUP.INIT,
                    payload: {
                        settings: this.settings,
                    },
                }, this.origin);
            });
            // send ConnectSettings to popup
            // note this settings and iframe.ConnectSettings could be different (especially: origin, popup, webusb, debug)
            // now popup is able to load assets
        } else if (data.type === POPUP.CANCEL_POPUP_REQUEST || data.type === UI.CLOSE_UI_WINDOW) {
            this.close();
        }
    }

    close(): void {
        this.locked = false;

        if (this.requestTimeout) {
            window.clearTimeout(this.requestTimeout);
            this.requestTimeout = 0;
        }

        if (this.openTimeout) {
            window.clearTimeout(this.openTimeout);
            this.openTimeout = 0;
        }
        if (this.closeInterval) {
            window.clearInterval(this.closeInterval);
            this.closeInterval = 0;
        }

        if (this.extensionPort) {
            this.extensionPort.disconnect();
            this.extensionPort = null;
        }

        if (this.extensionTabId) {
            // $FlowIssue chrome not declared outside
            chrome.tabs.update(this.extensionTabId, { active: true });
            this.extensionTabId = 0;
        }

        if (this._window) {
            if (this.settings.env === 'webextension') {
                // $FlowIssue chrome not declared outside
                chrome.tabs.remove(this._window.id);
            } else {
                this._window.close();
            }
            this._window = null;
        }
    }

    postMessage(message: CoreMessage): void {
        // post message before popup request finalized
        if (this.requestTimeout) {
            return;
        }

        // device needs interaction but there is no popup/ui
        // maybe popup request wasn't handled
        // ignore "ui_request_window" type
        if (!this._window && message.type !== UI.REQUEST_UI_WINDOW && this.openTimeout) {
            this.close();
            showPopupRequest(this.open.bind(this), () => { this.emit(POPUP.CLOSED); });
            return;
        }

        // post message to popup window
        if (this._window) { this._window.postMessage(message, this.origin); }
    }

    onBeforeUnload() {
        this.close();
    }
}
