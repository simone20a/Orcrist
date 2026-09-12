machine PackageManagerMigration {

    locations {
        agent inventory: Text;
        agent installOkRaw: Bool;
        agent failuresRaw: Nat[0..200];
        agent scriptsBrokenRaw: Nat[0..50];

        installOk: Bool = false;
        failures: Nat[0..200] = 200;
        scriptsBroken: Nat[0..50] = 50;
    }

    initial state Survey {
        writes inventory;
        prompt: "Read package.json, the lockfile and any CI config, and write down what the migration has to preserve: the scripts, the engines field, anything depending on npm's flat node_modules, and the current test command. Record the summary in " <inventory> ". Change no files.";
        otherwise -> Convert;
    }

    state Convert {
        prompt: "Convert the project to pnpm, preserving everything listed in " <inventory> ". If a previous round reported " <failures> " failing tests or " <scriptsBroken> " broken scripts, address those too. Edit files only: run no installs and no tests.";
        limit visits <= 3 else -> RolledBack;
        otherwise -> Install;
    }

    state Install {
        writes installOkRaw;
        prompt: "Run the pnpm install and report in " <installOkRaw> " whether it completed without errors. If it failed, say in your reply what it printed. Run nothing else.";
        set installOk = installOkRaw;
        on installOk == true -> Verify;
        otherwise -> Convert;
    }

    state Verify {
        writes failuresRaw, scriptsBrokenRaw;
        prompt: "Run the test suite and then each script declared in package.json. Report the number of failing tests in " <failuresRaw> " and the number of scripts that no longer run in " <scriptsBrokenRaw> ". Fix nothing.";
        set failures = failuresRaw;
        set scriptsBroken = scriptsBrokenRaw;
        on failures == 0 and scriptsBroken == 0 -> Document;
        otherwise -> Convert;
    }

    state Document {
        prompt: "Update the README and the CI config so the documented commands are the pnpm ones, and note the pnpm version used. Change no application code.";
        otherwise -> Migrated;
    }

    final state Migrated {}
    final state RolledBack {}
}
