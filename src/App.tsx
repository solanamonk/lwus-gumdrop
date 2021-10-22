import React, { useEffect, useState } from "react";
import {
  BrowserRouter,
  Link,
  Route,
  RouteComponentProps,
  Switch,
} from "react-router-dom";
import queryString from 'query-string';

import { createTheme, ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import {
  Box,
  Button,
  FormControl,
  InputLabel,
  MenuItem,
  Stack,
  Select,
  TextField,
} from "@mui/material";
import FilePresentIcon from '@mui/icons-material/FilePresent';

import {
  useWallet,
} from "@solana/wallet-adapter-react";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  AccountLayout,
  MintLayout,
  Token,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Coder,
} from "@project-serum/anchor"
import { keccak_256 } from "js-sha3";
import { sha256 } from "js-sha256";
import BN from 'bn.js';
import * as bs58 from "bs58";

import "./App.css";
import {
  useConnection,
  useColorMode,
  Connection,
} from "./contexts";
import { SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID } from "./utils";
import Header from "./components/Header/Header";
import { DragAndDrop } from "./components/DragAndDrop";
import { MerkleTree } from "./utils/merkle-tree";

type CreateProps = {};
type ClaimProps = {};
type HomeProps = {};

// type PhoneNumber = string;
// type TwitterHandle = string;
// type DiscordId = string;
// type Handle = PhoneNumber | TwitterHandle | DiscordId;

// NB: assumes no overflow
const randomBytes = () : Uint8Array => {
  // TODO: some predictable seed? sha256?
  const buf = new Uint8Array(4);
  window.crypto.getRandomValues(buf);
  return buf;
}

const MERKLE_DISTRIBUTOR_ID = new PublicKey("2BXKBuQPRVjV9e9qC2wAVJgFLWDH8MULRQ5W5ABmJj45");
const WHITESPACE = "\u00A0";

const idl = require("./utils/merkle_distributor.json");
const coder = new Coder(idl);

const Create = (
  props : CreateProps,
) => {
  const connection = useConnection();
  const wallet = useWallet();
  const [mint, setMint] = React.useState(localStorage.getItem("mint") || "");
  const [commMethod, setMethod] = React.useState(localStorage.getItem("commMethod") || "");
  const [filename, setFilename] = React.useState("");
  const [text, setText] = React.useState("");

  const submit = async (e : React.SyntheticEvent) => {
    e.preventDefault();

    if (!wallet.connected || wallet.publicKey === null) {
      throw new Error(`Wallet not connected`);
    }

    const claimants = JSON.parse(text);
    const totalClaim = claimants.reduce((acc, c) => acc + c.amount, 0);
    const pins = claimants.map(() => randomBytes());
    console.log(claimants, pins);

    if (claimants.length === 0) {
      throw new Error(`No claimants provided`);
    }

    let mintKey : PublicKey;
    try {
      mintKey = new PublicKey(mint);
    } catch (err) {
      throw new Error(`Invalid mint key ${err}`);
    }
    const mintAccount = await connection.getAccountInfo(mintKey);
    if (mintAccount === null) {
      throw new Error(`Could not fetch mint`);
    }
    if (!mintAccount.owner.equals(TOKEN_PROGRAM_ID)) {
      throw new Error(`Invalid mint owner ${mintAccount.owner.toBase58()}`);
    }
    if (mintAccount.data.length !== MintLayout.span) {
      throw new Error(`Invalid mint size ${mintAccount.data.length}`);
    }
    const mintInfo = MintLayout.decode(Buffer.from(mintAccount.data));


    const [creatorTokenKey, ] = await PublicKey.findProgramAddress(
      [
        wallet.publicKey.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mintKey.toBuffer(),
      ],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID
    );
    const creatorTokenAccount = await connection.getAccountInfo(creatorTokenKey);
    if (creatorTokenAccount === null) {
      throw new Error(`Could not fetch creator token account`);
    }
    if (creatorTokenAccount.data.length !== AccountLayout.span) {
      throw new Error(`Invalid token account size ${creatorTokenAccount.data.length}`);
    }
    const creatorTokenInfo = AccountLayout.decode(Buffer.from(creatorTokenAccount.data));
    if (new BN(creatorTokenInfo.amount, 8, "le").toNumber() < totalClaim) {
      throw new Error(`Creator token account does not have enough tokens`);
    }


    const leafs : Array<Buffer> = [];
    for (let idx = 0; idx < claimants.length; ++idx ) {
      const claimant = claimants[idx];
      const seeds = [
        mintKey.toBuffer(),
        Buffer.from(claimant.handle),
        Buffer.from(pins[idx]),
      ];
      const [claimantPda, bump] = await PublicKey.findProgramAddress(seeds, MERKLE_DISTRIBUTOR_ID);
      claimant.bump = bump;
      claimant.pda = claimantPda;
      leafs.push(Buffer.from(
        keccak_256.digest(
          [...new BN(idx).toArray("le", 8),
           ...claimantPda.toBuffer(),
           ...new BN(claimant.amount).toArray("le", 8),
          ]
        )
      ));
    }

    const tree = new MerkleTree(leafs);
    const root = tree.getRoot();


    const base = new Keypair();
    const [distributor, dbump] = await PublicKey.findProgramAddress(
      [
        Buffer.from("MerkleDistributor"),
        base.publicKey.toBuffer(),
      ],
      MERKLE_DISTRIBUTOR_ID);

    const [distributorTokenKey, ] = await PublicKey.findProgramAddress(
      [
        distributor.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        mintKey.toBuffer(),
      ],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID
    );

    claimants.forEach((_, idx) => {
      const proof = tree.getProof(idx);
      const verified = tree.verifyProof(idx, proof, root);

      if (!verified) {
        throw new Error("Merkle tree verification failed");
      }

      const claimant = claimants[idx];
      const params = [
        `distributor=${distributor}`,
        `handle=${claimant.handle}`,
        `amount=${claimant.amount}`,
        `index=${idx}`,
        `pin=${pins[idx]}`,
        `proof=${proof.map(b => bs58.encode(b))}`,
      ];
      console.log(`Link: claim?${params.join("&")}`);
    });

    const createDistributorTokenAccount = new TransactionInstruction({
        programId: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
        keys: [
            { pubkey: wallet.publicKey        , isSigner: true  , isWritable: true  } ,
            { pubkey: distributorTokenKey     , isSigner: false , isWritable: true  } ,
            { pubkey: distributor             , isSigner: false , isWritable: false } ,
            { pubkey: mintKey                 , isSigner: false , isWritable: false } ,
            { pubkey: SystemProgram.programId , isSigner: false , isWritable: false } ,
            { pubkey: TOKEN_PROGRAM_ID        , isSigner: false , isWritable: false } ,
            { pubkey: SYSVAR_RENT_PUBKEY      , isSigner: false , isWritable: false } ,
        ],
        data: Buffer.from([])
    });

    // initial merkle-distributor state
    const initDistributor = new TransactionInstruction({
        programId: MERKLE_DISTRIBUTOR_ID,
        keys: [
            { pubkey: base.publicKey          , isSigner: true  , isWritable: false } ,
            { pubkey: distributor             , isSigner: false , isWritable: true  } ,
            { pubkey: mintKey                 , isSigner: false , isWritable: false } ,
            { pubkey: wallet.publicKey        , isSigner: true  , isWritable: false } ,
            { pubkey: SystemProgram.programId , isSigner: false , isWritable: false } ,
        ],
        data: Buffer.from([
          ...Buffer.from(sha256.digest("global:new_distributor")).slice(0, 8),
          ...new BN(dbump).toArray("le", 1),
          ...root,
          ...new BN(totalClaim).toArray("le", 8),
          ...new BN(claimants.length).toArray("le", 8),
        ])
    })

    const transferToATA = Token.createTransferInstruction(
        TOKEN_PROGRAM_ID,
        creatorTokenKey,
        distributorTokenKey,
        wallet.publicKey,
        [],
        totalClaim
      );


    await Connection.sendTransactionWithRetry(
      connection,
      wallet,
      [
        createDistributorTokenAccount,
        initDistributor,
        transferToATA,
      ],
      [base]
    );
  };

  const handleFiles = (files) => {
    if (files.length !== 1) {
      alert("Expecting exactly one handle-file upload");
      return;
    }

    const file = files[0];
    const reader = new FileReader();
    reader.onload = (e) => {
      if (e !== null && e.target !== null) {
        if (typeof e.target.result === "string") {
          setFilename(file.name);
          setText(e.target.result);
        } else {
          alert(`Could not read uploaded file ${file}`);
        }
      }
    };
    reader.readAsText(file);
  };

  const fileUpload = (
    <React.Fragment>
      <DragAndDrop handleDrop={handleFiles} >
        <Stack
          direction="row"
          style={{
            width: "60ch",
            height: "15ch",
          }}
          sx={{
            border: '1px dashed grey',
            justifyContent: "center",
            alignContent: "center",
          }}
        >
          <Button
            variant="text"
            component="label"
            style={{
              padding: 0,
              // don't make the button click field too large...
              marginTop: "5ch",
              marginBottom: "5ch",
            }}
          >
            Upload a distribution list
            <input
              type="file"
              onChange={(e) => handleFiles(e.target.files)}
              hidden
            />
          </Button>
          {WHITESPACE}
          {/*For display alignment...*/}
          <Button
            variant="text"
            component="label"
            disabled={true}
            style={{color: "white", padding: 0}}
          >
            or drag it here
          </Button>
        </Stack>
      </DragAndDrop>
      {filename !== ""
      ? (<Box style={{
            display: 'flex',
            justifyContent: 'center',
            width: "60ch",
            color: "rgba(255,255,255,.8)",
          }}>
            <FilePresentIcon />
            <span>{WHITESPACE} Uploaded {filename}</span>
          </Box>
        )
      : (<Box/>)}
    </React.Fragment>
  );

  const createAirdrop = (
    <Button
      disabled={!wallet.connected}
      variant="contained"
      color="success"
      onClick={(e) => {
        const wrap = async () => {
          try {
            await submit(e);
          } catch (err) {
            alert(`Failed to create merkle drop: ${err}`);
          }
        };
        wrap();
      }}
      sx={{ marginRight: "4px" }}
    >
      Create Merkle Airdrop
    </Button>
  );

  return (
    <Stack spacing={2}>
      <TextField
        style={{width: "60ch"}}
        id="outlined-multiline-flexible"
        label="Mint"
        value={mint}
        onChange={(e) => {
          localStorage.setItem("mint", e.target.value);
          setMint(e.target.value);
        }}
      />
      <FormControl fullWidth>
        <InputLabel id="comm-method-label">Claim Distribution Method</InputLabel>
        <Select
          labelId="comm-method-label"
          id="comm-method-select"
          value={commMethod}
          label="Claim Distribution Method"
          onChange={(e) => {
            localStorage.setItem("commMethod", commMethod);
            setMethod(e.target.value);
          }}
          style={{textAlign: "left"}}
        >
          <MenuItem value={"discord"}>Discord</MenuItem>
          <MenuItem value={"slack"}>Slack</MenuItem>
          <MenuItem value={"twitter"}>Twitter</MenuItem>
          <MenuItem value={"sms"}>SMS</MenuItem>
        </Select>
      </FormControl>
      {commMethod !== "" && mint !== "" && fileUpload}
      {filename !== "" && createAirdrop}
    </Stack>
  );
};

const Claim = (
  props : RouteComponentProps<ClaimProps>,
) => {
  const connection = useConnection();
  const wallet = useWallet();

  let params = queryString.parse(props.location.search);
  const [distributor, setDistributor] = React.useState(params.distributor as string);
  const [handle, setHandle] = React.useState(params.handle as string);
  const [amountStr, setAmount] = React.useState(params.amount as string);
  const [indexStr, setIndex] = React.useState(params.index as string);
  const [pinStr, setPin] = React.useState(params.pin as string);
  const [proofStr, setProof] = React.useState(params.proof as string);

  const submit = async (e : React.SyntheticEvent) => {
    e.preventDefault();

    if (!wallet.connected || wallet.publicKey === null) {
      throw new Error(`Wallet not connected`);
    }

    const amount = Number(amountStr);
    const index = Number(indexStr);
    const pin = pinStr.split(",").map(Number);

    if (isNaN(amount)) {
      throw new Error(`Could not parse amount ${amountStr}`);
    }
    if (isNaN(index)) {
      throw new Error(`Could not parse index ${indexStr}`);
    }

    let distributorKey : PublicKey;
    try {
      distributorKey = new PublicKey(distributor);
    } catch (err) {
      throw new Error(`Invalid distributor key ${err}`);
    }
    const distributorAccount = await connection.getAccountInfo(distributorKey);
    if (distributorAccount === null) {
      throw new Error(`Could not fetch distributor`);
    }

    const distributorInfo = coder.accounts.decode(
      "MerkleDistributor", distributorAccount.data);

    const proof = proofStr.split(",").map(b => {
      const ret = Buffer.from(bs58.decode(b))
      if (ret.length !== 32)
        throw new Error(`Invalid proof hash length`);
      return ret;
    });

    console.log("Proof", proof);

    console.log(distributorInfo.mint.toBase58(), handle, pin);

    const [claimantPda, ] = await PublicKey.findProgramAddress(
      [
        distributorInfo.mint.toBuffer(),
        Buffer.from(handle),
        Buffer.from(pin),
      ],
      MERKLE_DISTRIBUTOR_ID
    );

    const leaf = Buffer.from(keccak_256.digest(
      [...new BN(index).toArray("le", 8),
       ...claimantPda.toBuffer(),
       ...new BN(amount).toArray("le", 8),
      ]
    ));

    console.log(leaf, claimantPda.toBase58(), MerkleTree.nodeHash(leaf));

    const matches = MerkleTree.verifyClaim(
      Buffer.from(keccak_256.digest(
        [...new BN(index).toArray("le", 8),
         ...claimantPda.toBuffer(),
         ...new BN(amount).toArray("le", 8),
        ]
      )),
      proof,
      Buffer.from(distributorInfo.root)
    );

    if (!matches) {
      throw new Error("Merkle proof does not match");
    }

    const [claimStatus, cbump] = await PublicKey.findProgramAddress(
      [
        Buffer.from("ClaimStatus"),
        Buffer.from(new BN(index).toArray("le", 8)),
        distributorKey.toBuffer(),
      ],
      MERKLE_DISTRIBUTOR_ID
    );

    const [distributorTokenKey, ] = await PublicKey.findProgramAddress(
      [
        distributorKey.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        distributorInfo.mint.toBuffer(),
      ],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID
    );

    const [walletTokenKey, ] = await PublicKey.findProgramAddress(
      [
        wallet.publicKey.toBuffer(),
        TOKEN_PROGRAM_ID.toBuffer(),
        distributorInfo.mint.toBuffer(),
      ],
      SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID
    );

    const setup : Array<TransactionInstruction> = [];

    if (await connection.getAccountInfo(walletTokenKey) === null) {
      setup.push(new TransactionInstruction({
          programId: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
          keys: [
              { pubkey: wallet.publicKey        , isSigner: true  , isWritable: true  } ,
              { pubkey: walletTokenKey          , isSigner: false , isWritable: true  } ,
              { pubkey: wallet.publicKey        , isSigner: false , isWritable: false } ,
              { pubkey: distributorInfo.mint    , isSigner: false , isWritable: false } ,
              { pubkey: SystemProgram.programId , isSigner: false , isWritable: false } ,
              { pubkey: TOKEN_PROGRAM_ID        , isSigner: false , isWritable: false } ,
              { pubkey: SYSVAR_RENT_PUBKEY      , isSigner: false , isWritable: false } ,
          ],
          data: Buffer.from([])
      }));
    }

    const claimAirdrop = new TransactionInstruction({
        programId: MERKLE_DISTRIBUTOR_ID,
        keys: [
            { pubkey: distributorKey          , isSigner: false , isWritable: true  } ,
            { pubkey: claimStatus             , isSigner: false , isWritable: true  } ,
            { pubkey: distributorTokenKey     , isSigner: false , isWritable: true  } ,
            { pubkey: walletTokenKey          , isSigner: false , isWritable: true  } ,
            { pubkey: wallet.publicKey        , isSigner: true  , isWritable: false } ,  // payer
            { pubkey: SystemProgram.programId , isSigner: false , isWritable: false } ,
            { pubkey: TOKEN_PROGRAM_ID        , isSigner: false , isWritable: false } ,
        ],
        data: Buffer.from([
          ...Buffer.from(sha256.digest("global:claim")).slice(0, 8),
          ...new BN(cbump).toArray("le", 1),
          ...new BN(index).toArray("le", 8),
          ...new BN(amount).toArray("le", 8),
          ...claimantPda.toBuffer(),
          ...new BN(proof.length).toArray("le", 4),
          ...Buffer.concat(proof),
        ])
    })

    await Connection.sendTransactionWithRetry(
      connection,
      wallet,
      [
        ...setup,
        claimAirdrop
      ],
      []
    );
  };

  return (
    <Stack spacing={2}>
      <TextField
        style={{width: "60ch"}}
        id="outlined-multiline-flexible"
        label="Distributor"
        value={distributor}
        onChange={(e) => setDistributor(e.target.value)}
      />
      <TextField
        style={{width: "60ch"}}
        id="outlined-multiline-flexible"
        label="Handle"
        value={handle}
        onChange={(e) => setHandle(e.target.value)}
      />
      <TextField
        style={{width: "60ch"}}
        id="outlined-multiline-flexible"
        label="Amount"
        value={amountStr}
        onChange={(e) => setAmount(e.target.value)}
      />
      <TextField
        style={{width: "60ch"}}
        id="outlined-multiline-flexible"
        label="Index"
        value={indexStr}
        onChange={(e) => setIndex(e.target.value)}
      />
      <TextField
        style={{width: "60ch"}}
        id="outlined-multiline-flexible"
        label="Pin"
        value={pinStr}
        onChange={(e) => setPin(e.target.value)}
      />
      <TextField
        style={{width: "60ch"}}
        id="outlined-multiline-flexible"
        label="Proof"
        multiline
        value={proofStr}
        onChange={(e) => setProof(e.target.value)}
      />
      <Box />
      <Button
        disabled={!wallet.connected}
        variant="contained"
        color="success"
        onClick={(e) => {
          const wrap = async () => {
            try {
              await submit(e);
            } catch (err) {
              alert(`Failed to claim merkle drop: ${err}`);
            }
          };
          wrap();
        }}
        sx={{ marginRight: "4px" }}
      >
        Claim Merkle Airdrop
      </Button>
    </Stack>
  );
};

const Home = (
  props : HomeProps,
) => {
  return (
    <Stack
      direction="row"
      spacing={2}
    >
      <Link to="/create">
        <Button
          style={{width: "30ch"}}
          variant="contained"
          color="info"
        >
          Create
        </Button>
      </Link>
      <Link to="/claim">
        <Button
          style={{width: "30ch"}}
          variant="contained"
          color="info"
        >
          claim
        </Button>
      </Link>
    </Stack>
  );
};

const getWindowDimensions = () => {
  const { innerWidth: width, innerHeight: height } = window;
  return {
    width,
    height,
  };
};

const useWindowDimensions = () => {
  const [windowDimensions, setWindowDimensions] = useState(
    getWindowDimensions()
  );

  useEffect(() => {
    const handleResize = () => {
      setWindowDimensions(getWindowDimensions());
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  return windowDimensions;
};

function App() {
  const colorModeCtx = useColorMode();

  const mode =
    colorModeCtx.mode === "dark" || !colorModeCtx.mode ? "dark" : "light";

  useEffect(() => {}, [colorModeCtx.mode]);

  const { height } = useWindowDimensions();

  const theme = React.useMemo(
    () =>
      createTheme({
        palette: {
          mode,
        },
      }),
    [colorModeCtx.mode]
  );

  return (
    <div className="App" style={{ backgroundColor: "transparent" }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <Header />
        <Box
          sx={{
            width: 600,
            height: "100%",
            flexGrow: 1,
            pt: `${Math.floor(0.2 * height)}px`,
            px: "50%",
            display: "flex",
            alignSelf: "center",
            justifyContent: "center",
            alignContent: "center",
          }}
        >
          <BrowserRouter>
            <Switch>
              <Route path="/create" component={Create} />
              <Route path="/claim" component={Claim} />
              <Route path="/" component={Home} />
            </Switch>
          </BrowserRouter>
        </Box>
      </ThemeProvider>
    </div>
  );
}

export default App;
