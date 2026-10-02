import { Hono } from 'hono';
import { z } from 'zod';
import { ModelServiceError, type ModelService } from './model-service.js';

// All routes sit under /api, behind the same host, origin, content-type and
// owner-token checks as everything else. They only ever call the service, whose
// results are strictly whitelisted: nothing here can reach a token or a key.
export function modelRoutes(models: ModelService) {
  const app = new Hono();
  app.onError((error, c) => {
    if (error instanceof ModelServiceError)
      return c.json({ error: error.message, code: error.code }, error.status);
    // Never echo an unknown error: it could carry anything.
    console.error('Model API request failed:', error.name);
    return c.json({ error: 'The model request could not be completed.' }, 500);
  });
  const body = async <T extends z.ZodType>(
    request: Request,
    schema: T,
    message: string,
  ): Promise<z.infer<T>> => {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success)
      throw new ModelServiceError('invalid_request', message, 400);
    return parsed.data;
  };
  app.get('/model', (c) => c.json(models.status()));
  app.put('/model/provider', async (c) => {
    const { provider } = await body(
      c.req.raw,
      z.strictObject({ provider: z.enum(['api-key', 'chatgpt-plan']) }),
      'Choose a provider.',
    );
    return c.json(models.setProvider(provider));
  });
  app.delete('/model/selection', (c) => c.json(models.clearSelection()));
  app.post('/model/chatgpt/sign-in', async (c) =>
    c.json(await models.startSignIn(), 202),
  );
  app.post('/model/chatgpt/sign-in/cancel', async (c) =>
    c.json(await models.cancelSignIn()),
  );
  app.post('/model/chatgpt/sign-out', async (c) =>
    c.json(await models.signOut()),
  );
  app.get('/model/chatgpt/models', (c) => c.json(models.models()));
  app.post('/model/chatgpt/models/refresh', async (c) =>
    c.json(await models.refreshModels()),
  );
  app.put('/model/chatgpt/model', async (c) => {
    const { model } = await body(
      c.req.raw,
      z.strictObject({ model: z.string().min(1).max(200) }),
      'Choose a model from the list.',
    );
    return c.json(await models.setChatGPTModel(model));
  });
  return app;
}
