import { SetMetadata } from '@nestjs/common';
export const PUBLIC_ROUTE_KEY='qeynox:public';
export const PublicRoute=()=>SetMetadata(PUBLIC_ROUTE_KEY,true);
