import type {
  PluginClientContext,
  PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { EnvSyncScreen } from "./client/sync-screen";

function Item({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon="RefreshCw"
      active={currentScreen?.screenId === "env-sync"}
      onPress={() => openScreen({ screenId: "env-sync" })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  client.addScreen({
    id: "env-sync",
    title: "Env Sync",
    Component: EnvSyncScreen,
  });
  client.addSettingsScreen({
    id: "env-sync",
    title: "Env Sync",
    icon: "RefreshCw",
    Component: EnvSyncScreen,
  });
  client.addSidebarFooterItem({
    id: "env-sync",
    title: "Env Sync",
    Component: Item,
  });
  return () => {};
}
