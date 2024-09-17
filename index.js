require("dotenv").config();
const express = require("express");
const app = express();
const jwt = require("jsonwebtoken");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); // Needed to process Stripe webhooks
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Add webhook secret

console.log(endpointSecret);

app.use(cors());
app.use("/webhook", express.raw({ type: "application/json" }));
app.use(express.json());

// For Stripe webhook handling

const port = process.env.PORT || 5000;

// Function to create JWT token
const createToken = (user) => {
  const token = jwt.sign(
    {
      email: user.email,
    },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "7d" }
  );
  return token;
};

// Middleware to verify JWT token
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(403).send("Authorization token is missing.");
  }

  try {
    const verify = jwt.verify(token, process.env.JWT_SECRET || "secret");
    if (!verify?.email) {
      return res.status(401).send("Unauthorized.");
    }
    req.user = verify.email;
    next();
  } catch (error) {
    return res.status(401).send("Invalid token.");
  }
};

const uri = process.env.DATABASE_URL;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    const productsDb = client.db("productsDb");
    const userDB = client.db("userDB");
    const ordersDB = client.db("ordersDB"); // New orders database
    const productsCollection = productsDb.collection("productsCollection");
    const usersCollection = userDB.collection("usersCollection");
    const ordersCollection = ordersDB.collection("ordersCollection"); // New orders collection

    // Product routes

    app.get("/products", async (req, res) => {
      const productData = productsCollection.find();
      const result = await productData.toArray();
      res.send(result);
    });

    app.post("/products", verifyToken, async (req, res) => {
      const productData = req.body;
      const result = await productsCollection.insertOne(productData);
      res.send(result);
    });

    app.get("/products/:id", async (req, res) => {
      const id = req.params.id;
      const productsData = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(productsData);
    });

    app.patch("/products/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData }
      );
      res.send(result);
    });

    app.delete("/products/:id", async (req, res) => {
      const id = req.params.id;
      const result = await productsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // User routes

    app.post("/users", async (req, res) => {
      const user = req.body;
      const token = createToken(user);

      const userExists = await usersCollection.findOne({ email: user?.email });
      if (userExists?._id) {
        return res.json({ message: "Login successful", token });
      }
      await usersCollection.insertOne(user);
      res.json({ token });
    });

    app.get("/users", async (req, res) => {
      const usersData = usersCollection.find();
      const result = await usersData.toArray();
      res.send(result);
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    app.patch("/users/:email", async (req, res) => {
      const email = req.params.email;
      const userData = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: userData },
        { upsert: true }
      );
      res.send(result);
    });

    // Payment routes

    app.post("/checkout", async (req, res) => {
      const { cart, email } = req.body;

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          customer_email: email,
          line_items: cart.map((item) => ({
            price_data: {
              currency: "usd",
              product_data: {
                name: item.title,
                // Stripe does not support images in product_data; you can store image URLs in metadata
              },
              unit_amount: Math.round(Number(item.price) * 100), // Stripe expects amount in cents
            },
            quantity: item.quantity,
            // Metadata to store additional info
            description: item.description, // Optional
            images: [item.image_url], // Add the image URL to metadata (Stripe does not display this in Checkout)
          })),
          mode: "payment",
          success_url: "https://cap-quest.vercel.app/success",
          cancel_url: "https://cap-quest.vercel.app/cancel",
        });

        res.json({ id: session.id });
      } catch (error) {
        console.error("Error creating checkout session:", error);
        res.status(500).json({ error: "Unable to create checkout session." });
      }
    });

    // Stripe webhook to handle payment success
    app.post("/webhook", async (req, res) => {
      const sig = req.headers["stripe-signature"];
      let event;

      try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
      } catch (err) {
        console.error("Webhook signature verification failed:", err);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        try {
          const lineItems = await stripe.checkout.sessions.listLineItems(
            session.id
          );

          // Calculate total items and total amount
          const totalItems = lineItems.data.reduce(
            (sum, item) => sum + item.quantity,
            0
          );
          const totalAmount =
            lineItems.data.reduce(
              (sum, item) => sum + item.price.unit_amount * item.quantity,
              0
            ) / 100; // Convert from cents to dollars

          const order = {
            email: session.customer_email,
            items: lineItems.data.map((item) => ({
              title: item.description,
              image_url: item.images[0], // Extract the image URL from metadata
              quantity: item.quantity,
              price: item.price.unit_amount / 100, // Convert from cents to dollars
            })),
            total_items: totalItems,
            total_amount: totalAmount,
            payment_status: session.payment_status,
            created_at: new Date(),
          };

          await ordersCollection.insertOne(order);
          console.log("Order created successfully:", order);
        } catch (err) {
          console.error("Failed to retrieve line items:", err);
        }
      }

      res.json({ received: true });
    });

    console.log("You successfully connected to MongoDB!");
  } finally {
    // Close the connection when done
  }
}

run().catch(console.log);

// Test route
app.get("/", (req, res) => {
  res.send("Hello World!");
});

// Start server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
