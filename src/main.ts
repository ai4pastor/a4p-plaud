import { Plugin } from "obsidian";

export default class A4PPlaudPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log("A4P Plaud loaded");
  }

  async onunload(): Promise<void> {
    console.log("A4P Plaud unloaded");
  }
}
