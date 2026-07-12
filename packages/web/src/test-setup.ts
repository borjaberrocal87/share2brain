// Vitest setup (Story 10.2, D10): importing the i18n singleton registers the
// default i18next instance so useTranslation() works in every component test
// without an I18nextProvider — and with the REAL `es` resources, so all
// existing Spanish-literal assertions keep passing unmodified.
import './i18n';
