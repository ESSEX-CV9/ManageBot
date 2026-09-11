import type { Client } from 'discord.js';
import { handleRoleRotationButton } from './components/roleRotationComponents';
import {
    handleRoleRotationMemberRemove,
    handleRoleRotationMemberUpdate,
    startRoleRotationScheduler,
} from './services/roleRotationScheduler';

export { handleRoleRotationButton };
export { handleRoleRotationMemberRemove, handleRoleRotationMemberUpdate };

export async function startRoleRotationSystem(client: Client): Promise<void> {
    await startRoleRotationScheduler(client);
    console.log('🔄 分管身份组轮替模块已加载');
}
