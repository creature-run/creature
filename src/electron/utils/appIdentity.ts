import { app } from "electron";
import { getBuildIdentity } from "../../../appIdentity";

export const getRuntimeAppName = (): string => {
  if (app.isPackaged) {
    return app.getName();
  }

  return getBuildIdentity().appName;
};

export const isProdRuntime = (): boolean => {
  return app.isPackaged && app.getName() === "Creature";
};
