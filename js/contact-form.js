/*
 * CLA-705 — contact form → Electro Bertels intake.
 *
 * POSTs JSON to the form's data-intake-url (POST /v1/website/consultations?site=electro-bertels).
 * The backend stores the request (bertels panel → Website → Consultation requests) and e-mails
 * the visitor a localized acknowledgement with a reference number.
 *
 * Behaviour:
 * - native validation (required / maxlength / email) before any request;
 * - one Idempotency-Key per submission, kept on a network failure so a retry of a request
 *   that did arrive is not stored twice, renewed after a success;
 * - submit disabled while sending (no double submit);
 * - 422 → errors next to each field, 429 → wait message, anything else → call/mail fallback;
 * - status announced through an aria-live region.
 *
 * Local development: on localhost/127.0.0.1 only, `?intake=<url>` overrides the endpoint
 * (never on a public host, so a crafted link cannot redirect visitor data elsewhere).
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
      'contact met ons op: '
  };

  var fields = ['name', 'email', 'message'];
  var status = document.getElementById('cf-status');
  var button = document.getElementById('submit-button');
  var idempotencyKey = null;

  function intakeUrl() {
    var url = form.getAttribute('data-intake-url');
    var host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      var override = new URLSearchParams(window.location.search).get('intake');
      if (override) {
        url = override;
      }
    }
    return url;
  }

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

    fetch(intakeUrl(), {
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
        setSending(false);
      });
  });
})();
