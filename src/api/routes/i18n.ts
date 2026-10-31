import { Router } from 'express';
import { getLocalePayload } from '../../i18n';

export function createI18nRouter(): Router {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(getLocalePayload(req));
  });

  return router;
}