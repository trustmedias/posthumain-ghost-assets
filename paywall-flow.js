/* POSTHUMAIN — paywall-flow.js (ex-Code injection footer, deplace sur GitHub le 08/10/2026)
 * Charge via : <script src="https://cdn.jsdelivr.net/gh/trustmedias/posthumain-ghost-assets@main/paywall-flow.js" defer></script>
 */
(function (run) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
})(function() {

  // RIEN A VOIR ICI MAIS ON OPTIMISE UN PEU LE CHARGEMENT DES IMAGES -- A RETIRER APRES PASSAGE A CLOUDFLARE
  const lcpImage = document.querySelector('.gh-article-image img');
  if (lcpImage) {
    lcpImage.setAttribute('loading', 'eager');
    lcpImage.setAttribute('fetchpriority', 'high');
    lcpImage.setAttribute('decoding', 'async');
  }

  // ---------------------------------------------------------------------------
  // Configuration Ghost Portal

  // 1 = clic direct vers l'abonnement mensuel payant pour tout le monde
  // 0 = visiteurs non connectés vers signup normal,
  //     membres gratuits connectés vers account/plans
  const DIRECT_PREMIUM_CHECKOUT = 0;

  const MONTHLY_PREMIUM_PORTAL = 'signup/680bfa5fc5301300089d6179/monthly';
  const NORMAL_SIGNUP_PORTAL = 'signup';

  // Page Welcome premium Ghost
  const PREMIUM_WELCOME_PATH = '/premium-active/';

  // Page intermédiaire après checkout / retour Stripe, tant que l'utilisateur est déconnecté
  const EMAIL_CHECK_PATH = '/verification-email/';

  // Destination pour les visiteurs non connectés
  const PREMIUM_PORTAL_TARGET = DIRECT_PREMIUM_CHECKOUT === 1
    ? MONTHLY_PREMIUM_PORTAL
    : NORMAL_SIGNUP_PORTAL;

  const PREMIUM_PORTAL_HREF = '#/portal/' + PREMIUM_PORTAL_TARGET;

  // Destination spéciale pour les membres gratuits déjà connectés
  const ACCOUNT_PLANS_TARGET = DIRECT_PREMIUM_CHECKOUT === 1
    ? MONTHLY_PREMIUM_PORTAL
    : 'account/plans';

  const ACCOUNT_PLANS_HREF = '#/portal/' + ACCOUNT_PLANS_TARGET;

  // ---------------------------------------------------------------------------
  // Masquage de l'offre gratuite dans le Portal pour les articles payants


  // Sécurité : on retire la classe au chargement, puis on la remet uniquement
  // si on détecte un vrai paywall premium.
  document.documentElement.classList.remove('posthumain-paid-paywall');

  const hideFreePlanStyle = document.createElement('style');
  hideFreePlanStyle.textContent = `
    .posthumain-paid-paywall .gh-portal-product-card.free,
    .posthumain-paid-paywall .gh-portal-product-card.free.checked {
      display: none !important;
    }
  `;
  document.head.appendChild(hideFreePlanStyle);

  // ---------------------------------------------------------------------------
  // Clés localStorage


  const LAST_PAYWALLED_ARTICLE_KEY = 'posthumain_last_paywalled_article';
  const SUBSCRIPTION_FLOW_STARTED_KEY = 'posthumain_subscription_flow_started';
  const EMAIL_CHECK_REDIRECTED_KEY = 'posthumain_email_check_redirected';

  const LAST_PAYWALLED_ARTICLE_MAX_AGE = 24 * 60 * 60 * 1000; // 24 heures

  // ---------------------------------------------------------------------------
  // Helpers pages


  function isPremiumWelcomePage() {
    return window.location.pathname === PREMIUM_WELCOME_PATH;
  }

  function isEmailCheckPage() {
    return window.location.pathname === EMAIL_CHECK_PATH;
  }

  function isGenericPage() {
    return (
      window.location.pathname === '/' ||
      window.location.pathname.startsWith('/page/') ||
      isPremiumWelcomePage() ||
      isEmailCheckPage()
    );
  }

  function isGenericReturnPageAfterCheckout() {
    return (
      window.location.pathname === '/' ||
      window.location.pathname.startsWith('/page/')
    );
  }

  // ----------------------------
  // Mémoire article / flow


  function rememberCurrentArticleBeforeSubscribe() {
    // URL propre, sans ?stripe=..., ?success=..., etc.
    const currentUrl = window.location.origin + window.location.pathname;

    if (isGenericPage()) {
      return;
    }

    localStorage.setItem(
      LAST_PAYWALLED_ARTICLE_KEY,
      JSON.stringify({
        url: currentUrl,
        createdAt: Date.now()
      })
    );
  }

  function markSubscriptionFlowStarted() {
    localStorage.setItem(
      SUBSCRIPTION_FLOW_STARTED_KEY,
      JSON.stringify({
        startedAt: Date.now()
      })
    );
  }

  function markEmailCheckRedirected() {
    localStorage.setItem(
      EMAIL_CHECK_REDIRECTED_KEY,
      JSON.stringify({
        redirectedAt: Date.now()
      })
    );
  }

  function clearSavedPaywalledArticle() {
    localStorage.removeItem(LAST_PAYWALLED_ARTICLE_KEY);
    localStorage.removeItem(SUBSCRIPTION_FLOW_STARTED_KEY);
    localStorage.removeItem(EMAIL_CHECK_REDIRECTED_KEY);
  }

  function getSavedPaywalledArticleUrl() {
    const savedDataRaw = localStorage.getItem(LAST_PAYWALLED_ARTICLE_KEY);

    if (!savedDataRaw) {
      return null;
    }

    let savedData;

    try {
      savedData = JSON.parse(savedDataRaw);
    } catch (e) {
      clearSavedPaywalledArticle();
      return null;
    }

    const savedArticleUrl = savedData.url;
    const createdAt = savedData.createdAt || 0;

    if (!savedArticleUrl || Date.now() - createdAt > LAST_PAYWALLED_ARTICLE_MAX_AGE) {
      clearSavedPaywalledArticle();
      return null;
    }

    return savedArticleUrl;
  }

  function subscriptionFlowWasStarted() {
    const raw = localStorage.getItem(SUBSCRIPTION_FLOW_STARTED_KEY);

    if (!raw) {
      return false;
    }

    try {
      const data = JSON.parse(raw);
      const startedAt = data.startedAt || 0;

      if (!startedAt || Date.now() - startedAt > LAST_PAYWALLED_ARTICLE_MAX_AGE) {
        clearSavedPaywalledArticle();
        return false;
      }

      return true;
    } catch (e) {
      clearSavedPaywalledArticle();
      return false;
    }
  }

  function emailCheckWasAlreadyRedirected() {
    const raw = localStorage.getItem(EMAIL_CHECK_REDIRECTED_KEY);

    if (!raw) {
      return false;
    }

    try {
      const data = JSON.parse(raw);
      const redirectedAt = data.redirectedAt || 0;

      if (!redirectedAt || Date.now() - redirectedAt > LAST_PAYWALLED_ARTICLE_MAX_AGE) {
        localStorage.removeItem(EMAIL_CHECK_REDIRECTED_KEY);
        return false;
      }

      return true;
    } catch (e) {
      localStorage.removeItem(EMAIL_CHECK_REDIRECTED_KEY);
      return false;
    }
  }

  // ---------------------------
  // Détection connexion Ghost

  function isGhostMemberProbablyLoggedIn() {
    return (
      document.body.classList.contains('member-logged-in') ||
      document.body.classList.contains('logged-in') ||
      document.querySelector('[data-members-signout]') ||
      document.querySelector('a[href="#/portal/account"]') ||
      document.querySelector('[data-portal="account"]') ||
      document.querySelector('[data-portal="account/plans"]')
    );
  }

  // ---------------------------------------------------------------------------
  // Redirection vers page intermédiaire / retour article


  function redirectToEmailCheckPageIfNeeded() {
    const savedArticleUrl = getSavedPaywalledArticleUrl();

    if (!savedArticleUrl) {
      return;
    }

    // Il faut que l'utilisateur ait réellement cliqué sur un bouton inscription/abonnement.
    if (!subscriptionFlowWasStarted()) {
      return;
    }

    // Si on l'a déjà envoyé une fois vers la page email, on ne recommence pas.
    // Cela évite la boucle si la personne a hésité et revient en arrière sans payer.
    if (emailCheckWasAlreadyRedirected()) {
      return;
    }

    if (isGhostMemberProbablyLoggedIn()) {
      return;
    }

    if (isPremiumWelcomePage() || isEmailCheckPage()) {
      return;
    }

    if (isGenericReturnPageAfterCheckout()) {
      markEmailCheckRedirected();
      window.location.href = EMAIL_CHECK_PATH;
    }
  }

  function redirectBackToArticleAfterLogin() {
    const savedArticleUrl = getSavedPaywalledArticleUrl();

    if (!savedArticleUrl) {
      return;
    }

    const currentCleanUrl = window.location.origin + window.location.pathname;
    const isLoggedIn = isGhostMemberProbablyLoggedIn();

    // Sur la page Welcome premium, on ne redirige pas depuis le script global.
    // Le script de /premium-active/ gère le spinner + retour article.
    if (isPremiumWelcomePage()) {
      return;
    }

    // Si on est déjà sur l'article mémorisé MAIS pas encore connecté,
    // on garde la mémoire. C'est typiquement le retour après Stripe.
    if (currentCleanUrl === savedArticleUrl && !isLoggedIn) {
      return;
    }

    // Si on est sur l'article mémorisé ET connecté, on nettoie.
    if (currentCleanUrl === savedArticleUrl && isLoggedIn) {
      clearSavedPaywalledArticle();
      return;
    }

    // Si on est connecté ailleurs, on revient à l'article.
    // Cela couvre surtout les comptes gratuits / freemium.
    if (isLoggedIn) {
      window.location.href = savedArticleUrl;
    }
  }

  function runPostSubscriptionRoutingChecks() {
    redirectToEmailCheckPageIfNeeded();
    redirectBackToArticleAfterLogin();
  }

  // ------------------------------------------------------
  // Vérifications répétées après retour / connexion Ghost


  let redirectCheckCount = 0;
  const redirectCheckInterval = setInterval(function() {
    redirectCheckCount += 1;

    runPostSubscriptionRoutingChecks();

    // 120 essais x 500 ms = 60 secondes max
    if (redirectCheckCount >= 120) {
      clearInterval(redirectCheckInterval);
    }
  }, 500);

  window.addEventListener('focus', function() {
    runPostSubscriptionRoutingChecks();
  });

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden) {
      runPostSubscriptionRoutingChecks();
    }
  });

  const memberRedirectObserver = new MutationObserver(function() {
    runPostSubscriptionRoutingChecks();
  });

  memberRedirectObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-portal', 'href']
  });

  window.addEventListener('hashchange', function() {
    runPostSubscriptionRoutingChecks();
  });

  // ---------------------------------------------------------------------------
  // Détection des boutons Portal liés à un paywall

  function pageHasPaywallPortalButton() {
    if (isGenericPage()) {
      return false;
    }

    const portalElements = Array.from(document.querySelectorAll('[data-portal]'));

    return portalElements.some(function(el) {
      const portalTarget = (el.getAttribute('data-portal') || '').toLowerCase();
      const text = (el.textContent || '').trim().toLowerCase();

      return (
        portalTarget.includes('signup') ||
        portalTarget.includes('account/plans') ||
        portalTarget.includes('upgrade') ||
        text.includes('s’abonner') ||
        text.includes('s\'abonner') ||
        text.includes('abonner') ||
        text.includes('débloquer') ||
        text.includes('créer un compte') ||
        text.includes('subscribe') ||
        text.includes('upgrade')
      );
    });
  }

  function rememberArticleIfPaywallPortalExists() {
    if (pageHasPaywallPortalButton()) {
      rememberCurrentArticleBeforeSubscribe();
    }
  }

  // Plusieurs essais, car Ghost peut injecter/modifier le paywall avec retard
  setTimeout(rememberArticleIfPaywallPortalExists, 300);
  setTimeout(rememberArticleIfPaywallPortalExists, 1000);
  setTimeout(rememberArticleIfPaywallPortalExists, 2500);
  setTimeout(rememberArticleIfPaywallPortalExists, 5000);

  // ---------------------------------------------------------------------------
  // Mémorisation robuste de l'article AVANT que Ghost ne capture le clic

  function shouldRememberArticleFromClick(target) {
    if (!target) {
      return false;
    }

    const explicitTrigger = target.closest('[data-posthumain-subscription-trigger="true"]');

    if (explicitTrigger) {
      return true;
    }

    const paywallOrUpgradeButton = target.closest(
      '[data-portal], ' +
      '.gh-post-upgrade-cta a, ' +
      '.gh-post-upgrade-cta button, ' +
      '.gh-post-upgrade-cta-content a, ' +
      '.gh-post-upgrade-cta-content button, ' +
      'a.gh-btn, ' +
      'button.gh-button'
    );

    if (!paywallOrUpgradeButton) {
      return false;
    }

    const buttonText = (paywallOrUpgradeButton.textContent || '').trim().toLowerCase();
    const portalTarget = (paywallOrUpgradeButton.getAttribute('data-portal') || '').toLowerCase();
    const href = (paywallOrUpgradeButton.getAttribute('href') || '').toLowerCase();

    return (
      portalTarget.includes('signup') ||
      portalTarget.includes('account/plans') ||
      portalTarget.includes('upgrade') ||
      href.includes('#/portal/signup') ||
      href.includes('#/portal/account/plans') ||
      buttonText.includes('s’abonner') ||
      buttonText.includes('s\'abonner') ||
      buttonText.includes('abonner') ||
      buttonText.includes('débloquer') ||
      buttonText.includes('créer un compte') ||
      buttonText.includes('upgrade') ||
      buttonText.includes('subscribe')
    );
  }

  function rememberArticleAndMarkFlow(target) {
    if (shouldRememberArticleFromClick(target)) {
      rememberCurrentArticleBeforeSubscribe();
      markSubscriptionFlowStarted();
    }
  }

  document.addEventListener('pointerdown', function(e) {
    rememberArticleAndMarkFlow(e.target);
  }, true);

  document.addEventListener('click', function(e) {
    rememberArticleAndMarkFlow(e.target);
  }, true);

  // ---------------------------------------------------------------------------
  // Traduction des messages d’abonnement / paywall

  const h2Element = document.querySelector('.gh-post-upgrade-cta-content h2');
  const smallTextElement = document.querySelector('.gh-post-upgrade-cta-content small');

  let isPaidPaywall = false;
  let isFreeMemberPaywall = false;

  if (h2Element) {
    const originalText = h2Element.textContent.trim().toLowerCase();

    if (originalText.includes('payants') || originalText.includes('premium')) {
      h2Element.textContent = 'Ce contenu est réservé aux Humains 2.0';
      isPaidPaywall = true;
      isFreeMemberPaywall = false;

      // Article payant : on masque l'offre gratuite dans le Portal.
      document.documentElement.classList.add('posthumain-paid-paywall');

    } else if (originalText.includes('cette publication') || originalText.includes('free member')) {
      h2Element.textContent = 'Créez un compte gratuit pour accéder à ce contenu';
      isFreeMemberPaywall = true;
      isPaidPaywall = false;

      // Article freemium : on garde l'offre gratuite visible.
      document.documentElement.classList.remove('posthumain-paid-paywall');
    }
  }

  // Si un paywall est détecté directement via le texte Ghost, on mémorise aussi.
  // Ici, on ne marque PAS le flow comme commencé : l'utilisateur n'a pas encore cliqué.
  if (isPaidPaywall || isFreeMemberPaywall) {
    rememberCurrentArticleBeforeSubscribe();
  }

  if (smallTextElement) {
    const signInUrl = window.location.href.split('#')[0] + '#/portal/signin';
    smallTextElement.innerHTML = 'Vous avez déjà un compte ? <a href="' + signInUrl + '" class="gh-portal-close">Connectez-vous</a>';
  }

  // ---------------------------------------------------------------------------
  // Bouton principal du paywall + cas des membres gratuits déjà connectés

  const paywallButton = document.querySelector('.gh-post-upgrade-cta a.gh-btn, .gh-post-upgrade-cta-content a.gh-btn');

  if (paywallButton) {
    const originalButtonText = paywallButton.textContent.trim().toLowerCase();
    const originalPortalTarget = paywallButton.getAttribute('data-portal') || '';

    const isLoggedInFreeUpgrade =
      originalPortalTarget === 'account/plans' ||
      originalPortalTarget === 'upgrade' ||
      originalButtonText.includes('upgrade your account') ||
      originalButtonText.includes('upgrade');

    if (isPaidPaywall && isLoggedInFreeUpgrade) {
      paywallButton.innerHTML = 'Débloquer l’accès complet';
      paywallButton.setAttribute('href', ACCOUNT_PLANS_HREF);
      paywallButton.setAttribute('data-portal', ACCOUNT_PLANS_TARGET);
      paywallButton.setAttribute('data-posthumain-subscription-trigger', 'true');

      paywallButton.addEventListener('click', function() {
        rememberCurrentArticleBeforeSubscribe();
        markSubscriptionFlowStarted();
      });
    } else if (isPaidPaywall) {
      paywallButton.innerHTML = 'S’abonner pour lire la suite';
      paywallButton.setAttribute('href', PREMIUM_PORTAL_HREF);
      paywallButton.setAttribute('data-portal', PREMIUM_PORTAL_TARGET);
      paywallButton.setAttribute('data-posthumain-subscription-trigger', 'true');

      paywallButton.addEventListener('click', function() {
        rememberCurrentArticleBeforeSubscribe();
        markSubscriptionFlowStarted();
      });
    } else if (isFreeMemberPaywall) {
      paywallButton.innerHTML = 'Créer un compte gratuit';
      paywallButton.setAttribute('href', '#/portal/signup/free');
      paywallButton.setAttribute('data-portal', 'signup/free');
      paywallButton.setAttribute('data-posthumain-subscription-trigger', 'true');

      paywallButton.addEventListener('click', function() {
        rememberCurrentArticleBeforeSubscribe();
        markSubscriptionFlowStarted();
      });
    }
  }

  // ----------------------------------------------------
  // Boutons d'upgrade secondaires, par exemple sidebar

  const sideBarUpgrade = document.querySelector('button.gh-button.gh-portal-close[data-portal="upgrade"]');

  if (sideBarUpgrade && sideBarUpgrade.textContent.trim().toLowerCase().includes('upgrade')) {
    sideBarUpgrade.innerHTML = 'Débloquer l’accès complet';
    sideBarUpgrade.setAttribute('data-portal', ACCOUNT_PLANS_TARGET);
    sideBarUpgrade.setAttribute('data-posthumain-subscription-trigger', 'true');

    sideBarUpgrade.addEventListener('click', function() {
      rememberCurrentArticleBeforeSubscribe();
      markSubscriptionFlowStarted();
    });
  }

  // FIN DU SCRIPT PAYWALL FLOW

  // ---------------------------------------------------------------------------
  // Insertion politique confidentialité footer

  const footerBar = document.querySelector('.gh-footer-bar');

  if (footerBar && !document.querySelector('.footer-links')) {
    const container = document.createElement('div');
    container.className = 'footer-links';

    const links = [
      { href: '/l-equipe/', text: "L'équipe" },
      { href: '/mentions-legales/', text: 'Mentions légales' },
      { href: '/politique-de-confidentialite/', text: 'Politique de confidentialité' }
    ];

    links.forEach(item => {
      const link = document.createElement('a');
      link.href = item.href;
      link.textContent = item.text;
      link.className = 'footer-extra-link';
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      container.appendChild(link);
    });

    footerBar.appendChild(container);
  }

});
