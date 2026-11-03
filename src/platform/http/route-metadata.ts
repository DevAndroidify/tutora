import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'route:isPublic';

/** Marks a route as reachable without an access token. Routes are private by default. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
