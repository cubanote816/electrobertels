/*
 * CLA-705 — contact form → Electro Bertels intake.
 *
 * POSTs JSON to the form's data-intake-url: the same-origin /intake/consultations. nginx on
 * this site forwards only that POST, through the tunnel, to the backoffice's
 * /v1/website/consultations?site=electro-bertels (the site is pinned by nginx, never by the
 * browser). The backend stores the request (bertels panel → Website → Consultation requests)
 * and e-mails the visitor a localized acknowledgement with a reference number.
 *
 * Behaviour:
 * - native validation (required / maxlength / email) before any request;
 * - one Idempotency-Key per submission, kept on a network failure so a retry of a request
 *   that did arrive is not stored twice, renewed after a success;
 * - submit disabled while sending (no double submit);
 * - 422 → errors next to each field, 429 → wait message, anything else (503 included: the
 *   backend refuses when the Bertels site is not active) → call/mail fallback;
 * - status announced through an aria-live region.
 *
 * Local development: on localhost/127.0.0.1 only, `?intake=<url>` overrides the endpoint
 * (never on a public host, so a crafted link cannot redirect visitor data elsewhere).
 *
 * CLA-731 — Cloudflare Turnstile: when the form carries `data-turnstile-sitekey`, the
 * Turnstile script is loaded (never otherwise) and a managed widget is rendered that only
 * shows itself when a visitor must interact. The submit waits for its token, sends it as
 * `turnstile_token`, and resets the widget after every attempt (tokens are single use).
 * If the widget cannot load or verify, the visitor gets the phone/e-mail fallback.
 * On localhost only, `?turnstile=<sitekey>` overrides the key for testing.
 */
(function () {
  'use strict';

  var form = document.getElementById('contact-form');
  if (!form || !window.fetch) {
    return;
  }

  var PHONE_DISPLAY = '014 81 30 80';
  var PHONE_TEL = 'tel:+3214813080';
  var EMAIL = 'info@electrobertels.be';

  var TEXT = {
    sending: 'Bezig met verzenden…',
    submit: 'Verzenden',
    success: 'Bedankt! Wij hebben uw bericht goed ontvangen. U krijgt binnen enkele minuten een ' +
      'bevestiging per e-mail. Wij nemen zo snel mogelijk contact met u op.',
    invalid: 'Controleer de gemarkeerde velden.',
    tooMany: 'U heeft te veel berichten na elkaar verstuurd. Probeer het over een minuut opnieuw.',
    failed: 'Uw bericht kon niet worden verzonden. Probeer het later opnieuw, of neem rechtstreeks ' +
      'contact met ons op: ',
    challenge: 'We konden niet bevestigen dat u geen robot bent. Probeer het opnieuw, of neem ' +
      'rechtstreeks contact met ons op: '
  };

  var TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=ebTurnstileReady';
  var TOKEN_WAIT_MS = 10000;

  var fields = ['name', 'email', 'message'];
  var status = document.getElementById('cf-status');
  var button = document.getElementById('submit-button');
  var idempotencyKey = null;

  function intakeUrl() {
    var url = form.getAttribute('data-intake-url');
    if (isLocalHost()) {
      var override = new URLSearchParams(window.location.search).get('intake');
      if (override) {
        url = override;
      }
    }
    return url;
  }

  function isLocalHost() {
    var host = window.location.hostname;
    return host === 'localhost' || host === '127.0.0.1';
  }

  // ---------------------------------------------------------------- Turnstile (CLA-731)

  var turnstile = {
    sitekey: (function () {
      var key = form.getAttribute('data-turnstile-sitekey') || '';
      if (isLocalHost()) {
        key = new URLSearchParams(window.location.search).get('turnstile') || key;
      }
      return key.trim();
    })(),
    widgetId: null,
    token: null,
    failed: false,
    waiters: []
  };

  function wakeTurnstileWaiters() {
    turnstile.waiters.splice(0).forEach(function (resolve) {
      resolve();
    });
  }

  function setTurnstileToken(token) {
    turnstile.token = token;
    turnstile.failed = false;
    wakeTurnstileWaiters();
  }

  function failTurnstile() {
    turnstile.token = null;
    turnstile.failed = true;
    wakeTurnstileWaiters();
  }

  function loadTurnstile() {
    if (!turnstile.sitekey) {
      return;
    }
    var note = document.getElementById('cf-privacy-turnstile');
    if (note) {
      note.hidden = false;
    }
    window.ebTurnstileReady = function () {
      try {
        turnstile.widgetId = window.turnstile.render('#cf-turnstile', {
          sitekey: turnstile.sitekey,
          action: 'contact',
          language: (document.documentElement.lang || 'nl').slice(0, 2),
          appearance: 'interaction-only',
          callback: setTurnstileToken,
          'expired-callback': function () {
            turnstile.token = null;
          },
          'error-callback': failTurnstile
        });
      } catch (e) {
        failTurnstile();
      }
    };
    var script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.onerror = failTurnstile;
    document.head.appendChild(script);
  }

  // Resolves once a token exists, the widget failed, or the wait runs out.
  function waitForTurnstileToken() {
    return new Promise(function (resolve) {
      if (!turnstile.sitekey || turnstile.token || turnstile.failed) {
        resolve();
        return;
      }
      var done = false;
      var timer = setTimeout(function () {
        done = true;
        resolve();
      }, TOKEN_WAIT_MS);
      turnstile.waiters.push(function () {
        if (!done) {
          done = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });
  }

  function resetTurnstile() {
    turnstile.token = null;
    if (turnstile.widgetId !== null && window.turnstile) {
      try {
        window.turnstile.reset(turnstile.widgetId);
      } catch (e) {
        // A reset that fails leaves no token: the next submit waits or falls back.
      }
    }
  }

  // ---------------------------------------------------------------- submission

  function newKey() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'cf-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }

  function errorElement(field) {
    return document.getElementById('cf-' + field + '-error');
  }

  function setFieldError(field, message) {
    var input = form.elements[field];
    var element = errorElement(field);
    if (!input || !element) {
      return;
    }
    if (message) {
      element.textContent = message;
      element.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.classList.add('is-invalid');
    } else {
      element.textContent = '';
      element.hidden = true;
      input.removeAttribute('aria-invalid');
      input.classList.remove('is-invalid');
    }
  }

  function clearErrors() {
    fields.forEach(function (field) {
      setFieldError(field, null);
    });
  }

  function showStatus(kind, text, withContact) {
    status.className = 'cf-status cf-status--' + kind;
    status.textContent = text;
    if (withContact) {
      var phone = document.createElement('a');
      phone.href = PHONE_TEL;
      phone.textContent = PHONE_DISPLAY;
      var mail = document.createElement('a');
      mail.href = 'mailto:' + EMAIL;
      mail.textContent = EMAIL;
      status.appendChild(phone);
      status.appendChild(document.createTextNode(' of '));
      status.appendChild(mail);
      status.appendChild(document.createTextNode('.'));
    }
    status.hidden = false;
  }

  function setSending(sending) {
    button.disabled = sending;
    button.setAttribute('aria-busy', sending ? 'true' : 'false');
    button.textContent = sending ? TEXT.sending : TEXT.submit;
  }

  function validateLocally() {
    var firstInvalid = null;
    fields.forEach(function (field) {
      var input = form.elements[field];
      if (input.value.trim() === '' && input.value !== '') {
        input.value = '';
      }
      if (!input.checkValidity()) {
        setFieldError(field, input.validationMessage);
        firstInvalid = firstInvalid || input;
      }
    });
    if (firstInvalid) {
      firstInvalid.focus();
      return false;
    }
    return true;
  }

  function applyServerErrors(errors) {
    var firstInvalid = null;
    Object.keys(errors || {}).forEach(function (field) {
      if (fields.indexOf(field) !== -1) {
        setFieldError(field, [].concat(errors[field])[0]);
        firstInvalid = firstInvalid || form.elements[field];
      }
    });
    return firstInvalid;
  }

  fields.forEach(function (field) {
    form.elements[field].addEventListener('input', function () {
      setFieldError(field, null);
      // Edited content is a new submission: never let a retry key replay the old one.
      idempotencyKey = null;
    });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (button.disabled) {
      return;
    }

    clearErrors();
    status.hidden = true;

    if (!validateLocally()) {
      showStatus('error', TEXT.invalid, false);
      return;
    }

    idempotencyKey = idempotencyKey || newKey();

    var payload = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      message: form.elements.message.value.trim(),
      locale: (document.documentElement.lang || 'nl').slice(0, 2).toLowerCase(),
      website_url: form.elements.website_url.value
    };

    setSending(true);

    waitForTurnstileToken().then(function () {
      if (turnstile.sitekey && !turnstile.token) {
        setSending(false);
        showStatus('error', TEXT.challenge, true);
        resetTurnstile();
        return null;
      }
      if (turnstile.sitekey) {
        payload.turnstile_token = turnstile.token;
      }
      return send(payload);
    });
  });

  function send(payload) {
    return fetch(intakeUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Idempotency-Key': idempotencyKey
      },
      body: JSON.stringify(payload)
    })
      .then(function (response) {
        return response.json().catch(function () {
          return {};
        }).then(function (body) {
          return { status: response.status, body: body };
        });
      })
      .then(function (result) {
        // The server answered, so it knows whether it stored the lead: the next attempt is new.
        idempotencyKey = null;
        if (result.status === 201) {
          form.reset();
          showStatus('success', TEXT.success, false);
          status.focus();
        } else if (result.status === 422 && result.body.errors && result.body.errors.turnstile_token) {
          showStatus('error', TEXT.challenge, true);
        } else if (result.status === 422) {
          var firstInvalid = applyServerErrors(result.body.errors);
          showStatus('error', TEXT.invalid, false);
          if (firstInvalid) {
            firstInvalid.focus();
          }
        } else if (result.status === 429) {
          showStatus('error', TEXT.tooMany, false);
        } else {
          showStatus('error', TEXT.failed, true);
        }
      })
      .catch(function () {
        // Network or CORS failure: keep the key so a retry cannot store the lead twice.
        showStatus('error', TEXT.failed, true);
      })
      .then(function () {
        // The token was spent (or may have been): always start from a fresh one.
        resetTurnstile();
        setSending(false);
      });
  }

  loadTurnstile();
})();
